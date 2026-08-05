import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  command: string;
}

export type ProcessCommandRunner = (command: string, args: string[]) => Promise<string>;

export interface ListProcessSnapshotsOptions {
  platform?: NodeJS.Platform;
  run?: ProcessCommandRunner;
}

export interface StopProcessByPidOptions {
  graceMs?: number;
  pollIntervalMs?: number;
  platform?: NodeJS.Platform;
  isAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => unknown;
  terminateWindowsTree?: (pid: number) => Promise<void>;
  logger?: { warn?: (message: string) => void; error?: (message: string) => void };
}

const WINDOWS_PROCESS_QUERY =
  "$ErrorActionPreference='Stop'; " +
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ' +
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ' +
  'ConvertTo-Json -Compress';

const NATIVE_ENGINE_NAME = 'gezel-(?:llama|ds4|sd|whisper)-server(?:\\.exe)?';
const PYTHON_ENGINE_NAME = 'gezel_(?:mlx|video)_server\\.py';
const NATIVE_ENGINE_ARGV0_RE = new RegExp(
  `^(?:"[^"]*[\\\\/]?${NATIVE_ENGINE_NAME}"|(?:\\S*[\\\\/])?${NATIVE_ENGINE_NAME})(?:\\s|$)`,
  'i',
);
const PYTHON_ENGINE_ARGV_RE = new RegExp(
  `^(?:"[^"]+"|\\S+)(?:\\s+-\\S+)*\\s+(?:"[^"]*[\\\\/]?${PYTHON_ENGINE_NAME}"|(?:\\S*[\\\\/])?${PYTHON_ENGINE_NAME})(?:\\s|$)`,
  'i',
);

/**
 * True only when the process itself is a known Gezel engine. Matching argv[0]
 * (or Python's first script argument) avoids treating an eval runner, editor,
 * or diagnostic command that merely mentions an engine path as the engine.
 */
export function isGezelEngineCommand(command: string): boolean {
  const trimmed = command.trim();
  return NATIVE_ENGINE_ARGV0_RE.test(trimmed) || PYTHON_ENGINE_ARGV_RE.test(trimmed);
}

/**
 * Return a full `(pid, ppid, command)` process snapshot on every desktop
 * platform Gezel supports. Windows has no `ps`; query Win32_Process through
 * the inbox Windows PowerShell instead. Keeping this in the client node entry
 * lets Electron, gezeld, and the eval harness share one parser and command
 * contract without importing service internals.
 */
export async function listProcessSnapshots(
  options: ListProcessSnapshotsOptions = {},
): Promise<ProcessSnapshot[]> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runProcessCommand;
  if (platform === 'win32') {
    const stdout = await run(windowsPowerShellPath(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_PROCESS_QUERY,
    ]);
    return parseWindowsProcessSnapshot(stdout);
  }
  if (platform === 'darwin' || platform === 'linux') {
    return parseUnixProcessSnapshot(await run('/bin/ps', ['-axo', 'pid=,ppid=,command=']));
  }
  return [];
}

/** Parse the portable `ps -axo pid=,ppid=,command=` shape. */
export function parseUnixProcessSnapshot(stdout: string): ProcessSnapshot[] {
  const out: ProcessSnapshot[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    out.push({ pid, ppid, command: match[3]! });
  }
  return out;
}

/** Parse the compressed JSON emitted by the Win32_Process CIM query. */
export function parseWindowsProcessSnapshot(stdout: string): ProcessSnapshot[] {
  const trimmed = stdout.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  const value: unknown = JSON.parse(trimmed);
  const rows = Array.isArray(value) ? value : [value];
  const out: ProcessSnapshot[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const candidate = row as Record<string, unknown>;
    const pid = Number(candidate.ProcessId);
    const ppid = Number(candidate.ParentProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
    const commandLine =
      typeof candidate.CommandLine === 'string' ? candidate.CommandLine.trim() : '';
    const executablePath =
      typeof candidate.ExecutablePath === 'string' ? candidate.ExecutablePath.trim() : '';
    out.push({ pid, ppid, command: commandLine || executablePath });
  }
  return out;
}

/**
 * Force-stop a Windows process and every descendant tracked by the OS.
 * `process.kill()` maps both SIGTERM and SIGKILL to TerminateProcess on
 * Windows and only targets one pid, which is exactly how native engines were
 * left behind when an owning daemon was force-stopped.
 */
export async function terminateWindowsProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid process id: ${pid}`);
  await execFileAsync(windowsSystem32Path('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Stop a daemon when only its pid is available (for example an adopted stale
 * runtime or `gezel stop`). POSIX gets a bounded SIGTERM -> SIGKILL ladder.
 * Windows skips the misleading single-process SIGTERM and force-stops the
 * complete descendant tree, then confirms the daemon pid disappeared.
 */
export async function stopProcessByPid(
  pid: number,
  options: StopProcessByPidOptions = {},
): Promise<boolean> {
  const graceMs = options.graceMs ?? 3_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const platform = options.platform ?? process.platform;
  const alive = options.isAlive ?? isProcessAlive;
  const signal = options.signalProcess ?? ((target, sig) => process.kill(target, sig));
  if (!alive(pid)) return true;

  if (platform === 'win32') {
    try {
      await (options.terminateWindowsTree ?? terminateWindowsProcessTree)(pid);
    } catch (error) {
      // `taskkill` can lose a race with natural exit. Only fall back to a
      // direct process kill when the daemon is still observable.
      if (!alive(pid)) return true;
      options.logger?.warn?.(
        `[gezel] Windows process-tree termination failed for pid=${pid}; falling back to direct kill: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        signal(pid, 'SIGKILL');
      } catch {
        /* verify liveness below */
      }
    }
    const stopped = await waitForPidExit(pid, graceMs, pollIntervalMs, alive);
    if (!stopped) options.logger?.error?.(`[gezel] Windows process tree pid=${pid} survived stop`);
    return stopped;
  }

  try {
    signal(pid, 'SIGTERM');
  } catch {
    /* verify liveness below; ESRCH is success, EPERM remains alive */
  }
  if (await waitForPidExit(pid, graceMs, pollIntervalMs, alive)) return true;

  options.logger?.warn?.(`[gezel] pid=${pid} ignored SIGTERM; sending SIGKILL`);
  try {
    signal(pid, 'SIGKILL');
  } catch {
    /* verify liveness below */
  }
  const stopped = await waitForPidExit(pid, graceMs, pollIntervalMs, alive);
  if (!stopped) options.logger?.error?.(`[gezel] pid=${pid} survived SIGKILL`);
  return stopped;
}

async function runProcessCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(stdout);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (alive(pid) && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Math.min(pollIntervalMs, remaining))),
    );
  }
  return !alive(pid);
}

function windowsPowerShellPath(): string {
  return windowsSystem32Path(join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
}

function windowsSystem32Path(executable: string): string {
  const root = process.env.SystemRoot?.trim();
  return root ? join(root, 'System32', executable) : executable;
}
