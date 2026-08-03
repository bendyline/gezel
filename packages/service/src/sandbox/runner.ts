import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowsDetachedSpawnOptions } from '@bendyline/gezel/native';
import { runUnderMacSandbox } from './macos.js';

export interface SandboxRunOptions {
  entry: string;
  cwd: string;
  input: string;
  timeoutMs?: number;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  extraReadPaths?: string[];
  /** Extra CLI args to pass to the script itself. */
  scriptArgs?: string[];
  /** Extra env vars to set on the child. Merged on top of `sandboxEnv`. */
  extraEnv?: Record<string, string>;
  /**
   * When true, pass `--experimental-strip-types` so the script can be
   * a `.ts` file. Supported from Node 22.6+. Default false (caller
   * opts in) to preserve backwards-compat behavior for existing task
   * scripts that ship as `.js`.
   */
  stripTypes?: boolean;
  /**
   * When true, block outbound network from the child. Execution fails
   * closed unless macOS Seatbelt `(deny network*)` or a probed Linux
   * systemd user-service address-family boundary is available. A
   * JS-layer neutralizer is also imported before user code as
   * defense-in-depth;
   * it covers fetch/WebSocket, socket APIs, and both callback and promise
   * DNS APIs, but is deliberately not treated as a security boundary by
   * itself. The child only talks to the host over its fd-3 RPC pipe, so
   * denying sockets does not block legitimate RPC. Default false
   * (workspace build/test commands may legitimately need network).
   */
  denyNet?: boolean;
  /**
   * Trusted-provenance escape hatch for `denyNet`: when true and this
   * platform has no OS network boundary, run anyway under the remaining
   * layers (permission-model fs scoping, no child processes/workers/
   * addons, JS network neutralizer) instead of failing closed. Callers
   * may set this ONLY for first-party code whose bytes they have
   * verified against a shipped source of truth (catalog project-type
   * scripts, the stdlib) — never for user- or model-authored scripts,
   * whose confinement still requires the OS fence. Where a boundary IS
   * available it is still applied; this flag never weakens an
   * enforceable platform.
   */
  allowMissingNetBoundary?: boolean;
  /**
   * macOS machine-service compatibility lane. When Seatbelt itself fails
   * to start a byte-verified, read-only first-party script, allow one
   * retry under the remaining Node permission + JS network-denial layers.
   * The ScriptRunner sets this only for standard-scope scripts whose
   * declared capabilities are all read-only.
   */
  allowMacSandboxStartupFallback?: boolean;
  /**
   * Cap the V8 old-space heap (in MB) via `--max-old-space-size`. Bounds
   * a runaway allocation so a sandboxed script can't OOM the whole host.
   * Omit for no cap (Node's default, sized to system memory).
   */
  maxOldSpaceMb?: number;
  /**
   * When set, open fd 3 as a bidirectional newline-delimited pipe
   * between the runner and the child. Used by the ScriptRunner to
   * drive the `@bendyline/gezel-sdk` RPC channel. `onLine` fires for
   * every `\n`-terminated frame the child sends; `onOpen` is called
   * once after spawn with a `send(line)` function the runner uses to
   * write back to fd 3.
   */
  rpcChannel?: {
    onLine(line: string): void;
    onOpen(send: (line: string) => void): void;
  };
  /**
   * On macOS, relax sandbox-exec read restrictions to the whole
   * filesystem while keeping writes scoped. Mirrors the option of the
   * same name on `runUnderMacSandbox`. Needed when the Node
   * installation or script dependencies read from paths outside the
   * tight default allowlist (e.g. /opt/homebrew, /private/var/…).
   */
  relaxReads?: boolean;
}

export interface SandboxRunResult {
  exitCode: number;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Present when a trusted macOS job retried after Seatbelt failed to start. */
  sandboxFallback?: 'trusted-readonly-macos-seatbelt-startup';
}

/**
 * Spawn a node script under the strongest sandbox we can manage on this
 * platform. Layers used (in priority order):
 *
 *   1. Node's permission model with path-scoped fs reads/writes. Node 22
 *      spells the opt-in `--experimental-permission`; newer releases use
 *      `--permission`. The runner probes the selected binary once and uses
 *      the flag it actually advertises. All of
 *      --allow-child-process, --allow-worker, --allow-addons are left OFF.
 *   2. denyNet work is wrapped by macOS `sandbox-exec` or a probed Linux
 *      systemd user service restricted to AF_UNIX sockets.
 *   3. A wall-clock timeout, cooperative kill on cancel.
 *
 * The caller is responsible for having already run `npm install
 * --ignore-scripts` in `cwd` — this runner only executes, never installs.
 */
export async function runInSandbox(opts: SandboxRunOptions): Promise<SandboxRunResult> {
  // Prefer the bundled Node the supervisor laid down at
  // `~/.gezel/bin/node[.exe]` (via `GEZEL_NODE_PATH`) so users don't
  // need a system-wide Node install for `run_nodejs_script`. In dev
  // and tests, use the current executable instead of a PATH lookup so
  // sandboxed children survive env-scrubbing and test env mutation.
  const nodeBin = process.env.GEZEL_NODE_PATH || process.execPath;
  const permissionFlag = await resolveNodePermissionFlag(nodeBin);

  // A preload can remove the public socket APIs, but user-supplied code
  // executes in the same JS runtime and therefore must not be trusted to
  // enforce its own confinement. Refuse to start denyNet work unless a
  // OS boundary is present. Node's Permission Model explicitly does not
  // claim to contain malicious code; its network permission arrived only
  // in Node 25, not any Node 22 release. Linux may use a systemd user
  // service with RestrictAddressFamilies=AF_UNIX after an executable probe;
  // other unsupported paths fail closed instead of presenting the JS
  // backstop as network isolation.
  const macSandboxAvailable = process.platform === 'darwin' && (await canApplyMacSandbox());
  const linuxSystemdSandboxAvailable =
    process.platform === 'linux' && !opts.rpcChannel && (await canApplyLinuxSystemdSandbox());
  if (
    opts.denyNet &&
    !opts.allowMissingNetBoundary &&
    selectDenyNetBoundary({
      platform: process.platform,
      macSandboxAvailable,
      linuxSystemdSandboxAvailable,
    }) === 'unavailable'
  ) {
    const result = networkSandboxUnavailableResult();
    for (const line of splitLines(result.stderr)) opts.onStderr?.(line);
    return result;
  }

  // realpath the scratch dir: on macOS tmpdir() is `/var/folders/…`, a
  // symlink to `/private/var/folders/…`. Node's module loader realpaths
  // the `--import` preload path, and `--permission`'s `--allow-fs-read`
  // is compared against the realpath — so the symlinked and resolved
  // forms must match or the preload read is denied (ERR_ACCESS_DENIED).
  const workdir = await realpath(await mkdtemp(join(tmpdir(), 'gezel-task-')));
  try {
    const cwd = await realpath(opts.cwd).catch(() => opts.cwd);
    const entryCandidate = isAbsolute(opts.entry) ? opts.entry : join(cwd, opts.entry);
    const entry = await realpath(entryCandidate).catch(() => opts.entry);
    const readPaths = await expandPermissionPaths([
      opts.cwd,
      workdir,
      ...(opts.extraReadPaths ?? []),
    ]);
    const writePaths = await expandPermissionPaths([opts.cwd, workdir]);

    // When egress is denied, drop a JS-layer network neutralizer the
    // child `--import`s before user code. The OS/runtime boundary checked
    // above is the real fence; this preload is cross-platform
    // defense-in-depth. It lives in the scratch read allowlist.
    const netBlockArgs: string[] = [];
    if (opts.denyNet) {
      const preloadPath = join(workdir, '__net_block.mjs');
      await writeFile(preloadPath, NET_BLOCK_PRELOAD, 'utf8');
      netBlockArgs.push(`--import=${pathToFileURL(preloadPath).href}`);
    }

    const nodeArgs: string[] = [
      permissionFlag,
      ...netBlockArgs,
      ...(opts.maxOldSpaceMb ? [`--max-old-space-size=${opts.maxOldSpaceMb}`] : []),
      ...readPaths.map((p) => `--allow-fs-read=${p}`),
      ...writePaths.map((p) => `--allow-fs-write=${p}`),
      ...(opts.stripTypes ? ['--experimental-strip-types'] : []),
      entry,
      ...(opts.scriptArgs ?? []),
    ];

    const childEnv = {
      ...sandboxEnv(process.env),
      GEZEL_SANDBOX: '1',
      ...(opts.extraEnv ?? {}),
    };

    const { command, args } = await wrapForPlatform(nodeBin, nodeArgs, {
      workdir: cwd,
      scratch: workdir,
      relaxReads: opts.relaxReads,
      denyNet: opts.denyNet,
      macSandboxAvailable,
      linuxSystemdSandboxAvailable,
      timeoutMs: opts.timeoutMs,
      childEnv,
    });

    const childOpts = cwd === opts.cwd ? opts : { ...opts, cwd };
    const first = await runSandboxChild(command, args, childOpts);
    const allowTrustedMacFallback =
      opts.allowMacSandboxStartupFallback === true && opts.allowMissingNetBoundary === true;
    const macSandboxStartupFailed =
      shouldRetryWithoutMacSandbox(first) ||
      (allowTrustedMacFallback && isSilentMacSandboxStartupFailure(first, process.platform));
    if (command === 'sandbox-exec' && macSandboxStartupFailed) {
      // A denyNet job cannot retry without Seatbelt: doing so would
      // silently turn a sandbox startup failure into network access,
      // except for the explicit byte-verified, read-only standard-script
      // lane. That lane keeps the Node permission model and the JS network
      // neutralizer armed and records the degraded boundary in its result.
      if (opts.denyNet && !allowTrustedMacFallback) {
        return {
          ...first,
          stderr: `${first.stderr}${NETWORK_SANDBOX_RETRY_REFUSED}\n`,
        };
      }
      const retried = await runSandboxChild(nodeBin, nodeArgs, childOpts);
      return allowTrustedMacFallback
        ? {
            ...retried,
            sandboxFallback: 'trusted-readonly-macos-seatbelt-startup',
          }
        : retried;
    }
    return first;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

const nodePermissionFlagCache = new Map<
  string,
  Promise<'--permission' | '--experimental-permission'>
>();

/**
 * Select the permission-model flag from `node --help` instead of assuming
 * the service process and the configured/bundled child binary are the same
 * release. Gezel currently ships Node 22, whose spelling is still
 * `--experimental-permission`; passing the stabilized spelling makes every
 * sandboxed script exit 9 before user code starts.
 */
export function selectNodePermissionFlag(
  helpText: string,
): '--permission' | '--experimental-permission' | null {
  if (/^\s*--permission(?:\s|$)/m.test(helpText)) return '--permission';
  if (/^\s*--experimental-permission(?:\s|$)/m.test(helpText)) {
    return '--experimental-permission';
  }
  return null;
}

async function resolveNodePermissionFlag(
  nodeBin: string,
): Promise<'--permission' | '--experimental-permission'> {
  const cached = nodePermissionFlagCache.get(nodeBin);
  if (cached) return cached;
  const pending = readNodeHelp(nodeBin).then((helpText) => {
    const flag = selectNodePermissionFlag(helpText);
    if (!flag) {
      throw new Error(
        `[sandbox error] Node at ${nodeBin} does not advertise a supported permission-model flag`,
      );
    }
    return flag;
  });
  nodePermissionFlagCache.set(nodeBin, pending);
  try {
    return await pending;
  } catch (err) {
    nodePermissionFlagCache.delete(nodeBin);
    throw err;
  }
}

async function readNodeHelp(nodeBin: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(nodeBin, ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sandboxEnv(process.env),
      // Bundled Node is a console-subsystem executable and the Session 0
      // machine service can allocate no console — so even this capability
      // probe starts with DETACHED_PROCESS. `windowsHide`
      // (CREATE_NO_WINDOW) does not do that; it still allocates.
      ...windowsDetachedSpawnOptions(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`failed to inspect Node permission support (${code}): ${stderr}`));
    });
  });
}

async function runSandboxChild(
  command: string,
  args: string[],
  opts: SandboxRunOptions,
): Promise<SandboxRunResult> {
  return await new Promise<SandboxRunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: opts.rpcChannel ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      // Keep sandbox children out of the Vitest/service process
      // group. Workspace commands already do this; doing the same
      // here prevents an unrelated process-group kill from closing a
      // short-lived derive/script child with a null exit code.
      // On Windows the same option is DETACHED_PROCESS, which also keeps a
      // console-subsystem child from asking the Session 0 service for a
      // console it cannot allocate — `windowsHide` (CREATE_NO_WINDOW) does
      // not, because it still allocates one. `taskkill /T` is unaffected:
      // detaching changes console and process group, not the recorded parent.
      detached: true,
      // Allowlist-scrub the env — inheriting everything leaked tokens
      // (GEZEL_TOKEN, OPENAI_API_KEY, GITHUB_PERSONAL_ACCESS_TOKEN,
      // etc.) into the sandboxed script, letting it `fetch` them
      // out. Keep only what a well-behaved Node script legitimately
      // needs to resolve the interpreter and find its home dir.
      // systemd-run needs the caller's user-bus coordinates, but the
      // transient service itself starts through `env -i` with only the
      // scrubbed childEnv embedded by wrapForPlatform. Never let the user
      // manager's broader environment become the script environment.
      env:
        command === 'systemd-run'
          ? {
              ...sandboxEnv(process.env),
              ...(process.env.XDG_RUNTIME_DIR
                ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }
                : {}),
              ...(process.env.DBUS_SESSION_BUS_ADDRESS
                ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
                : {}),
            }
          : {
              ...sandboxEnv(process.env),
              GEZEL_SANDBOX: '1',
              ...(opts.extraEnv ?? {}),
            },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killSandboxProcess(child);
        }, opts.timeoutMs)
      : null;
    timer?.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      for (const line of splitLines(text)) opts.onStdout?.(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      for (const line of splitLines(text)) opts.onStderr?.(line);
    });

    if (opts.rpcChannel) {
      const rpcStream = child.stdio[3] as (NodeJS.ReadableStream & NodeJS.WritableStream) | null;
      if (rpcStream) {
        let rpcBuffer = '';
        rpcStream.on('data', (chunk: Buffer | string) => {
          rpcBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          let nl = rpcBuffer.indexOf('\n');
          while (nl >= 0) {
            const line = rpcBuffer.slice(0, nl);
            rpcBuffer = rpcBuffer.slice(nl + 1);
            if (line.length > 0) opts.rpcChannel?.onLine(line);
            nl = rpcBuffer.indexOf('\n');
          }
        });
        rpcStream.on('error', () => {
          /* child may exit before we've finished writing — not fatal */
        });
        opts.rpcChannel.onOpen((line: string) => {
          try {
            rpcStream.write(line);
          } catch {
            /* writer may close during shutdown — swallow to let exit codes flow */
          }
        });
      }
    }

    child.on('error', (err) => {
      stderr += `[spawn error] ${err instanceof Error ? err.message : String(err)}\n`;
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const signalSuffix = code === null && signal ? `[process closed by signal ${signal}]\n` : '';
      resolve({
        exitCode: code ?? -1,
        signal,
        stdout,
        stderr: `${stderr}${signalSuffix}`,
        timedOut,
      });
    });

    child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

function shouldRetryWithoutMacSandbox(result: SandboxRunResult): boolean {
  return (
    process.platform === 'darwin' &&
    result.exitCode === -1 &&
    result.signal === 'SIGABRT' &&
    !result.timedOut &&
    result.stdout.length === 0 &&
    result.stderr === '[process closed by signal SIGABRT]\n'
  );
}

/**
 * The macOS machine-service identity can make sandbox-exec exit 1 before
 * Node starts, with no stdout/stderr at all. Limit recognition of that
 * otherwise-ambiguous shape to callers that explicitly selected the
 * trusted read-only fallback lane.
 */
export function isSilentMacSandboxStartupFailure(
  result: SandboxRunResult,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === 'darwin' &&
    result.exitCode === 1 &&
    !result.signal &&
    !result.timedOut &&
    result.stdout.trim().length === 0 &&
    result.stderr.trim().length === 0
  );
}

function killSandboxProcess(child: ChildProcess): void {
  if (process.platform === 'win32') {
    child.kill('SIGKILL');
    return;
  }
  const pid = child.pid;
  if (typeof pid !== 'number') {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function splitLines(text: string): string[] {
  return text.split('\n').filter((l) => l.length > 0);
}

async function expandPermissionPaths(paths: string[]): Promise<string[]> {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    for (const candidate of [p, await realpath(p).catch(() => p)]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      expanded.push(candidate);
    }
  }
  return expanded;
}

/**
 * Allowlist-scrub the parent process env before we pass it into a
 * sandboxed script. A script that fetches `process.env.GEZEL_TOKEN`
 * and POSTs it to an attacker would undo the rest of the sandbox.
 *
 * Keep: `PATH` / `PATHEXT` (module / binary resolution), `HOME` +
 * `USERPROFILE` (used by Node's home-dir APIs), `NODE_*` (engine
 * tuning), `LANG` / `LC_*` (locale), plus a minimal Windows set needed
 * for the interpreter to function. Strip everything else.
 */
export function sandboxEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const ALLOW_EXACT = new Set([
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'COMSPEC',
    'WINDIR',
  ]);
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    // Match case-INSENSITIVELY. Windows env var names keep whatever case
    // the parent process set them in (`Path`, `SystemRoot`, `windir`,
    // `ProgramData`, …), and `Set.has` is case-sensitive — so a plain
    // `ALLOW_EXACT.has('Path')` against an uppercase allowlist silently
    // drops PATH on any Windows box that hands it over as `Path`, leaving
    // the sandboxed shell unable to find node/npm/git. Keep the ORIGINAL
    // key case in the output so the child still sees the name it expects.
    const ku = k.toUpperCase();
    if (ALLOW_EXACT.has(ku) || ku.startsWith('NODE_') || ku.startsWith('LC_')) {
      out[k] = v;
    }
  }
  return out;
}

export type DenyNetBoundary = 'macos-seatbelt' | 'linux-systemd' | 'unavailable';

/** Pure policy selector kept separate from the executable probes for tests. */
export function selectDenyNetBoundary(input: {
  platform: NodeJS.Platform;
  macSandboxAvailable: boolean;
  linuxSystemdSandboxAvailable?: boolean;
}): DenyNetBoundary {
  if (input.platform === 'darwin' && input.macSandboxAvailable) return 'macos-seatbelt';
  if (input.platform === 'linux' && input.linuxSystemdSandboxAvailable) {
    return 'linux-systemd';
  }
  return 'unavailable';
}

const NETWORK_SANDBOX_UNAVAILABLE =
  '[sandbox error] denyNet requires an enforceable OS network boundary. This platform has no supported boundary, so the script was not started.';
const NETWORK_SANDBOX_RETRY_REFUSED =
  '[sandbox error] macOS Seatbelt failed to start and retrying without it would remove the denyNet boundary; the script was not retried.';

function networkSandboxUnavailableResult(): SandboxRunResult {
  return {
    exitCode: 126,
    stdout: '',
    stderr: `${NETWORK_SANDBOX_UNAVAILABLE}\n`,
    timedOut: false,
  };
}

async function wrapForPlatform(
  command: string,
  args: string[],
  ctx: {
    workdir: string;
    scratch: string;
    relaxReads?: boolean;
    denyNet?: boolean;
    macSandboxAvailable: boolean;
    linuxSystemdSandboxAvailable: boolean;
    timeoutMs?: number;
    childEnv: Record<string, string>;
  },
): Promise<{ command: string; args: string[] }> {
  if (process.platform === 'darwin' && ctx.macSandboxAvailable) {
    return runUnderMacSandbox(command, args, ctx, {
      relaxReads: ctx.relaxReads,
      denyNet: ctx.denyNet,
    });
  }
  if (process.platform === 'linux' && ctx.denyNet && ctx.linuxSystemdSandboxAvailable) {
    const runtimeSeconds = Math.max(30, Math.ceil((ctx.timeoutMs ?? 5 * 60_000) / 1_000) + 5);
    return {
      command: 'systemd-run',
      args: [
        '--user',
        '--quiet',
        '--pipe',
        '--wait',
        '--collect',
        '-p',
        'RestrictAddressFamilies=AF_UNIX',
        '-p',
        `RuntimeMaxSec=${runtimeSeconds}`,
        `--working-directory=${ctx.workdir}`,
        '--',
        '/usr/bin/env',
        '-i',
        ...Object.entries(ctx.childEnv).map(([key, value]) => `${key}=${value}`),
        command,
        ...args,
      ],
    };
  }
  // Reached by non-denyNet work, and by provenance-trusted denyNet work
  // on platforms with no OS boundary (`allowMissingNetBoundary`) — the
  // permission model + JS neutralizer layers still apply to the bare run.
  return { command, args };
}

let macSandboxProbe: Promise<boolean> | undefined;

export function canApplyMacSandbox(): Promise<boolean> {
  macSandboxProbe ??= new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const child = spawn('sandbox-exec', ['-p', '(version 1)\n(allow default)', '/usr/bin/true'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: sandboxEnv(process.env),
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 1000);
    timer.unref?.();
    child.on('error', () => finish(false));
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
  return macSandboxProbe;
}

let linuxSystemdSandboxProbe: Promise<boolean> | undefined;

/**
 * Verify that the current user manager can start a transient service and
 * that RestrictAddressFamilies actually rejects an AF_INET socket. Merely
 * finding `systemd-run` is insufficient: containers and stripped-down user
 * managers may accept the command while declining the security property.
 */
export function canApplyLinuxSystemdSandbox(): Promise<boolean> {
  if (process.platform !== 'linux') return Promise.resolve(false);
  linuxSystemdSandboxProbe ??= new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const probe =
      "const net=require('node:net');" +
      "const s=net.connect({host:'127.0.0.1',port:9});" +
      "s.once('connect',()=>process.exit(9));" +
      "s.once('error',e=>process.exit(['EAFNOSUPPORT','EPERM','EACCES'].includes(e.code)?0:2));" +
      'setTimeout(()=>process.exit(3),1000);';
    const child = spawn(
      'systemd-run',
      [
        '--user',
        '--quiet',
        '--pipe',
        '--wait',
        '--collect',
        '-p',
        'RestrictAddressFamilies=AF_UNIX',
        '-p',
        'RuntimeMaxSec=3',
        '--',
        process.execPath,
        '-e',
        probe,
      ],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        // These coordinates are for the trusted systemd-run client only.
        // The transient unit itself starts through `env -i` and never sees
        // them (see wrapForPlatform/runSandboxChild above).
        env: {
          ...sandboxEnv(process.env),
          ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
          ...(process.env.DBUS_SESSION_BUS_ADDRESS
            ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
            : {}),
        },
      },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 3_000);
    timer.unref?.();
    child.on('error', () => finish(false));
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
  return linuxSystemdSandboxProbe;
}

/**
 * JS-layer network neutralizer, `--import`ed into the sandboxed child
 * before user code when `denyNet` is set. The child reaches the host
 * only over its fd-3 RPC pipe (wrapped in `net.Socket` via the fd
 * constructor, which never calls `.connect()`), so removing outbound
 * primitives costs legitimate scripts nothing. This is defense-in-depth
 * beneath an OS/runtime boundary, never the sole basis for denyNet.
 */
export const NET_BLOCK_PRELOAD = `import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
const blocked = (what) => {
  throw new Error('network access is disabled in this sandbox: ' + what);
};
for (const name of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) {
  try {
    Object.defineProperty(globalThis, name, {
      value: () => blocked(name),
      writable: false,
      configurable: false,
    });
  } catch {}
}
net.Socket.prototype.connect = function () {
  return blocked('net.connect');
};
dgram.Socket.prototype.connect = function () {
  return blocked('dgram.connect');
};
dgram.Socket.prototype.send = function () {
  return blocked('dgram.send');
};

const dnsMethods = [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
  'reverse',
];
const blockDnsMethods = (target, label) => {
  if (!target) return;
  for (const name of dnsMethods) {
    if (typeof target[name] !== 'function') continue;
    try {
      Object.defineProperty(target, name, {
        value: function () { return blocked(label + '.' + name); },
        writable: false,
        configurable: false,
      });
    } catch {}
  }
};
blockDnsMethods(dns, 'dns');
blockDnsMethods(dns.promises, 'dns.promises');
blockDnsMethods(dns.Resolver?.prototype, 'dns.Resolver');
blockDnsMethods(dnsPromises, 'dns/promises');
blockDnsMethods(dnsPromises.Resolver?.prototype, 'dns/promises.Resolver');

// Built-in ESM named exports are snapshotted separately from the CommonJS
// facade. Synchronize them so named node:dns imports cannot retain originals.
syncBuiltinESMExports();
`;
