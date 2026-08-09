/**
 * Ask the OS service manager whether the Gezel machine service is
 * registered, and whether it is running or on its way up.
 *
 * This exists because runtime-file discovery alone races service startup.
 * The installer enables GezelService and launches the app within seconds,
 * but the service publishes `runtime/{port,auth-token,cert.pem}` only once
 * its daemon has fully booted — 20-30s later on a first start. A supervisor
 * that answers "is the machine service there?" by reading those files gets
 * `null` inside that window, silently falls through to the per-user spawn,
 * and the user ends up with TWO daemons: the machine service serving the
 * system-scope home and a per-user gezeld serving `~/.gezel`, each loading
 * its own multi-GB model (observed 2026-08-03: two llama-servers, ~20 GB
 * combined, on a 32 GB machine). The service manager knows the truth
 * immediately and authoritatively; the files only say "booted", not
 * "registered". Query the SCM first, and only wait on files when it says a
 * service is actually coming.
 *
 * Same construction as machine-service-state.ts: injectable exec so tests
 * never touch the real SCM, pure parsers exported for direct coverage.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Windows SCM name; matches the installer's `sc create` in nsis-hooks.nsh. */
const WINDOWS_SERVICE_NAME = 'GezelService';
/** launchd label; matches the macOS PKG scripts. */
const DARWIN_SERVICE_LABEL = 'com.bendyline.gezeld';
/** systemd unit; matches the Linux package scripts. */
const LINUX_SERVICE_UNIT = 'gezeld.service';

export type MachineServiceStatus =
  /** No registration exists — per-user paths are the right answer, no wait. */
  | 'not-installed'
  /** Registered and running (or actively starting) — worth waiting for. */
  | 'running'
  | 'start-pending'
  /** Registered but not running — runtime files, if present, are stale. */
  | 'stopped'
  /** The SCM could not be consulted — callers keep legacy file-only behavior. */
  | 'unknown';

export interface MachineServiceState {
  status: MachineServiceStatus;
  /** Raw evidence for the log line — parser input excerpt or error text. */
  detail?: string;
}

/** Injectable exec seam. Resolves with stdout; rejects like execFile does. */
export type ServiceQueryExec = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ServiceQueryExec = async (command, args) => {
  // windowsHide for the same reason machine-service-state.ts gives: this
  // runs in the interactive Electron main process, and CREATE_NO_WINDOW
  // just suppresses the console flash of sc.exe.
  const { stdout, stderr } = await execFileAsync(command, args, {
    windowsHide: true,
    timeout: 10_000,
  });
  return { stdout, stderr };
};

/**
 * Parse `sc.exe query <name>` output into a status.
 *
 * The line of interest is `        STATE              : 4  RUNNING`. Labels
 * and state names have historically stayed English on localized Windows,
 * but the numeric code is the contract — parse the number first and treat
 * the token as corroboration only. Codes: 1 STOPPED, 2 START_PENDING,
 * 3 STOP_PENDING, 4 RUNNING, 5 CONTINUE_PENDING, 6 PAUSE_PENDING, 7 PAUSED.
 */
export function parseScQueryState(stdout: string): MachineServiceStatus {
  const stateLine = stdout
    .split(/\r?\n/)
    .find((line) => /:\s*\d+\s+[A-Z_]+/.test(line) && /STATE/i.test(line));
  const fromLine = stateLine ?? stdout;
  const numeric = /:\s*(\d+)\s+[A-Z_]+/.exec(fromLine)?.[1];
  const code = numeric !== undefined ? Number.parseInt(numeric, 10) : null;
  switch (code) {
    case 1:
    case 3:
      return 'stopped';
    case 2:
      return 'start-pending';
    case 4:
    case 5:
    case 6:
    case 7:
      // Continue/pause-pending and paused all mean a live process holds the
      // service — the runtime files it published are trustworthy.
      return 'running';
    default:
      break;
  }
  // Numeric parse failed (unexpected localization). Fall back to the
  // unlocalized state tokens before giving up.
  if (/\bRUNNING\b/.test(stdout)) return 'running';
  if (/\bSTART_PENDING\b/.test(stdout)) return 'start-pending';
  if (/\bSTOPPED\b|\bSTOP_PENDING\b/.test(stdout)) return 'stopped';
  return 'unknown';
}

/**
 * Parse `launchctl print system/<label>` output. A loaded daemon prints a
 * `state = running` line while active; a loaded-but-idle daemon omits it or
 * prints another state. A missing service makes launchctl exit non-zero,
 * which the caller maps to `not-installed` before this parser runs.
 */
export function parseLaunchctlPrintState(stdout: string): MachineServiceStatus {
  const state = /state\s*=\s*(\w+)/.exec(stdout)?.[1];
  if (state === 'running') return 'running';
  if (state) return 'stopped';
  // Loaded print output with no state line — registered, not running.
  return 'stopped';
}

/**
 * Parse `systemctl show <unit> --property=LoadState --property=ActiveState`.
 * systemctl exits 0 even for unknown units and reports `LoadState=not-found`,
 * so absence is data here rather than an exec failure.
 */
export function parseSystemctlShowState(stdout: string): MachineServiceStatus {
  const props = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const load = props.get('LoadState');
  if (!load) return 'unknown';
  if (load === 'not-found' || load === 'masked') return 'not-installed';
  const active = props.get('ActiveState');
  if (active === 'active' || active === 'deactivating') return 'running';
  if (active === 'activating' || active === 'reloading') return 'start-pending';
  if (active === 'inactive' || active === 'failed') return 'stopped';
  return 'unknown';
}

/** Windows: exec errors carry the child's exit code; 1060 = no such service. */
function windowsStatusFromError(err: unknown): MachineServiceState {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 1060 || /\b1060\b/.test(message)) {
    return { status: 'not-installed', detail: 'sc.exe: service does not exist (1060)' };
  }
  return { status: 'unknown', detail: `sc.exe query failed: ${message}` };
}

/**
 * Query the platform service manager for the Gezel machine service.
 * Never throws — an unqueryable SCM degrades to `unknown`, which callers
 * treat exactly like the pre-SCM behavior (single runtime-file read).
 */
export async function queryMachineServiceState(
  options: { platform?: NodeJS.Platform; exec?: ServiceQueryExec } = {},
): Promise<MachineServiceState> {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;

  try {
    if (platform === 'win32') {
      try {
        const { stdout } = await exec('sc.exe', ['query', WINDOWS_SERVICE_NAME]);
        return { status: parseScQueryState(stdout), detail: firstStateLine(stdout) };
      } catch (err) {
        return windowsStatusFromError(err);
      }
    }
    if (platform === 'darwin') {
      try {
        const { stdout } = await exec('launchctl', ['print', `system/${DARWIN_SERVICE_LABEL}`]);
        return { status: parseLaunchctlPrintState(stdout), detail: firstStateLine(stdout) };
      } catch (err) {
        // launchctl exits non-zero ("Could not find service …") for an
        // unregistered daemon. Any other failure is indistinguishable in
        // exit code, so inspect the message before concluding absence.
        const message = err instanceof Error ? err.message : String(err);
        if (/could not find service/i.test(message)) {
          return { status: 'not-installed', detail: 'launchctl: service not found' };
        }
        return { status: 'unknown', detail: `launchctl failed: ${message}` };
      }
    }
    if (platform === 'linux') {
      try {
        // `--system` is explicit: the user-level autostart unit historically
        // shared this unit name (now gezeld-user.service), and an unqualified
        // query in a user session could answer for the wrong scope.
        const { stdout } = await exec('systemctl', [
          '--system',
          'show',
          LINUX_SERVICE_UNIT,
          '--property=LoadState',
          '--property=ActiveState',
          '--no-pager',
        ]);
        return { status: parseSystemctlShowState(stdout), detail: stdout.trim().slice(0, 120) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: 'unknown', detail: `systemctl failed: ${message}` };
      }
    }
    return { status: 'not-installed', detail: `no machine service on ${platform}` };
  } catch (err) {
    // Defensive: the per-platform branches already catch, but a seam that
    // throws synchronously must not take the supervisor down with it.
    return { status: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }
}

function firstStateLine(stdout: string): string | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /state/i.test(l));
  return line?.slice(0, 120);
}
