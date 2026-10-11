/**
 * Windows process container for `runInSandbox`, through Microsoft's MXC
 * (github.com/microsoft/mxc). The signed standalone launcher `wxc-exec.exe`
 * takes the whole policy as one base64 argument and passes stdin, stdout and
 * stderr straight through, so it wraps the Node command line the same way
 * `sandbox-exec` and `systemd-run` do on the other platforms.
 *
 * The container is used whenever an executable probe passes and nobody turned
 * it off (`setWindowsMxcEnabled`, `GEZEL_MXC=off`). Otherwise Windows keeps
 * failing denyNet work closed, exactly as before.
 *
 * Constraints measured on Windows 11 26H2 (base-container tier):
 *   - Node needs Win32k: the default `ui.disable: true` kills node.exe at DLL
 *     init (0xC0000142). Clipboard and input injection stay denied.
 *   - Every ancestor of a granted path is unreadable, and Node's module
 *     loader lstat's each one while resolving real paths, so the run adds
 *     `--preserve-symlinks` and `--preserve-symlinks-main`. A drive-root grant
 *     would fix that too, but it cascades to the whole volume.
 *   - The container cannot reach host loopback and inherits no handle beyond
 *     the standard three, so script RPC rides stdio (see stdio-rpc.ts).
 *   - A caller in Session 0 (a service, an SSH logon) gets containers whose
 *     node.exe fails DLL init: its window station grants nothing to app
 *     containers. The probe reports such a host as unavailable.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { readVerifiedMxcExecutor, windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';

const log = createLogger('sandbox');

export const MXC_EXEC_ENV = 'GEZEL_MXC_EXEC';
/** `GEZEL_MXC=off` turns the container off for this process, whatever the config says. */
export const MXC_SWITCH_ENV = 'GEZEL_MXC';
export const MXC_MAX_CONCURRENT_ENV = 'GEZEL_MXC_MAX_CONCURRENT';

export const MXC_NODE_PATH_FLAGS = ['--preserve-symlinks', '--preserve-symlinks-main'] as const;

/**
 * Module resolution for a run inside the container, `--import`ed before
 * anything else. `--preserve-symlinks` keeps Node away from the ancestors it
 * cannot read, but then a package reached through a pnpm junction resolves
 * its own dependencies from the junction's folder, where they are not
 * (`express()` → "Cannot find module 'body-parser'"). `fs.realpathSync.native`
 * is refused in the container too; reading a link is not. So this resolves
 * real paths by walking the path, skipping ancestors it may not inspect and
 * following each link it finds — which also gives every module one identity,
 * as Node's own realpath would.
 */
export const MXC_RESOLVE_HOOK = `import { lstatSync, readlinkSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const resolved = new Map();
function containedRealpath(path, depth = 0) {
  if (depth > 32) return path;
  const cached = resolved.get(path);
  if (cached) return cached;
  const { root } = parse(path);
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = readlinkSync(current);
    const real = containedRealpath(
      join(isAbsolute(target) ? target : resolve(dirname(current), target), ...parts.slice(i + 1)),
      depth + 1,
    );
    resolved.set(path, real);
    return real;
  }
  resolved.set(path, path);
  return path;
}

const realUrl = (url) => {
  if (typeof url !== 'string' || !url.startsWith('file:')) return url;
  return pathToFileURL(containedRealpath(fileURLToPath(url))).href;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parentURL = context.parentURL ? realUrl(context.parentURL) : context.parentURL;
    const result = nextResolve(specifier, { ...context, parentURL });
    return { ...result, url: realUrl(result.url) };
  },
});
`;

/** Variables the process container refuses to launch without. */
const MXC_REQUIRED_ENV = ['SYSTEMROOT', 'LOCALAPPDATA'] as const;
/** Windows refuses command lines past 32,767 characters; leave room for the launcher path. */
const MAX_REQUEST_CHARS = 30_000;
const DEFAULT_BACKSTOP_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const TRANSIENT_RETRY_MS = 10 * 60_000;
const MAX_PROBE_ATTEMPTS = 3;
const STATUS_DLL_INIT_FAILED = 0xc0000142;

export class MxcPolicyError extends Error {}

let launcherHome: string | null = null;

/**
 * The gezel home whose `engines/mxc/<version>/` may hold a verified launcher.
 * A daemon the supervisor started gets `GEZEL_MXC_EXEC`; autostart, the CLI
 * and npm installs find the launcher here instead.
 */
export function setWindowsMxcHome(home: string): void {
  launcherHome = home;
}

/** `GEZEL_MXC_EXEC` when set (an operator's choice wins outright), else the verified install. */
export function resolveMxcExecutor(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[MXC_EXEC_ENV]?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  return launcherHome ? readVerifiedMxcExecutor(launcherHome) : null;
}

export function defaultSandboxNodeBin(): string {
  return process.env.GEZEL_NODE_PATH || process.execPath;
}

export interface MxcRunPolicy {
  command: string;
  args: readonly string[];
  cwd: string;
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
  env: Record<string, string>;
  denyNet: boolean;
  timeoutMs?: number;
}

export interface MxcGrantGuards {
  /** Grants that contain one of these are refused: they would expose them whole. */
  privateRoots?: readonly string[];
  /** Write grants that contain one of these are refused: the run could replace them. */
  protectedPaths?: readonly string[];
}

export function buildMxcRequest(
  policy: MxcRunPolicy,
  guards: MxcGrantGuards = {},
  hostEnv: NodeJS.ProcessEnv = process.env,
) {
  const writable = dedupe(policy.readwritePaths);
  const writableKeys = new Set(writable.map(pathKey));
  const readonly = dedupe(policy.readonlyPaths).filter((p) => !writableKeys.has(pathKey(p)));
  assertSafeGrants(writable, readonly, guards);
  return {
    version: '1.0.0',
    containerId: `gezel-${randomUUID()}`,
    containment: 'processcontainer',
    lifecycle: { destroyOnExit: true },
    process: {
      commandLine: windowsCommandLine([policy.command, ...policy.args]),
      cwd: policy.cwd,
      env: mxcEnvironment(policy.env, hostEnv),
      // The runner owns the real deadline and kills the launcher, which takes
      // the container with it; this only backstops a runner that died.
      timeout: (policy.timeoutMs ?? DEFAULT_BACKSTOP_MS) + 5_000,
    },
    filesystem: { readwritePaths: writable, readonlyPaths: readonly },
    network: {
      egress: { default: policy.denyNet ? 'deny' : 'allow' },
      ingress: { default: 'deny', hostLoopback: 'deny' },
    },
    ui: { disable: false, clipboard: 'none', injection: false },
    // Tier 3 rewrites DACLs on host folders for the run. Refuse it: a host
    // that cannot isolate without it is a host without the boundary.
    fallback: { allowDaclMutation: false },
  };
}

export function encodeMxcRequest(request: ReturnType<typeof buildMxcRequest>): string {
  return Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
}

/** Wrap a Node command line for `wxc-exec.exe`. Throws {@link MxcPolicyError}. */
export function wrapForWindowsMxc(
  executor: string,
  policy: MxcRunPolicy,
  guards: MxcGrantGuards = defaultGrantGuards(executor, policy.command),
): { command: string; args: string[] } {
  const encoded = encodeMxcRequest(buildMxcRequest(policy, guards));
  if (encoded.length > MAX_REQUEST_CHARS) {
    throw new MxcPolicyError(
      `the sandbox request is ${encoded.length} characters; Windows allows about 32,000 on one command line`,
    );
  }
  return { command: executor, args: ['--config-base64', encoded] };
}

export function defaultGrantGuards(executor: string, nodeBin: string): MxcGrantGuards {
  const privateRoots = [homedir(), process.env.GEZEL_HOME].filter((p): p is string => !!p);
  return { privateRoots, protectedPaths: [executor, nodeBin] };
}

/**
 * The run's environment as the container sees it: scratch for temp files, and
 * no PATH, since the permission model already forbids starting programs.
 */
export function containerEnvironment(
  childEnv: Record<string, string>,
  scratch: string,
): Record<string, string> {
  const dropped = new Set(['PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(childEnv)) {
    if (!dropped.has(key.toUpperCase())) out[key] = value;
  }
  out.TEMP = scratch;
  out.TMP = scratch;
  return out;
}

/**
 * Join argv into one Windows command line that CommandLineToArgvW (and so
 * node.exe) splits back into the same argv.
 */
export function windowsCommandLine(argv: readonly string[]): string {
  return argv.map(quoteWindowsArg).join(' ');
}

function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
    } else {
      out += `${'\\'.repeat(backslashes)}${ch}`;
    }
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

function mxcEnvironment(env: Record<string, string>, hostEnv: NodeJS.ProcessEnv): string[] {
  const out = { ...env };
  const present = new Set(Object.keys(out).map((k) => k.toUpperCase()));
  for (const name of MXC_REQUIRED_ENV) {
    if (present.has(name)) continue;
    const hostKey = Object.keys(hostEnv).find((k) => k.toUpperCase() === name);
    const value = hostKey ? hostEnv[hostKey] : undefined;
    if (value) out[name] = value;
  }
  return Object.entries(out).map(([k, v]) => `${k}=${v}`);
}

function assertSafeGrants(
  writable: readonly string[],
  readonly: readonly string[],
  guards: MxcGrantGuards,
): void {
  for (const grant of [...writable, ...readonly]) {
    if (isVolumeOrShareRoot(grant)) {
      throw new MxcPolicyError(
        `refusing to grant ${grant}: a drive or share root opens the whole volume`,
      );
    }
    for (const root of guards.privateRoots ?? []) {
      if (containsPath(grant, root)) {
        throw new MxcPolicyError(`refusing to grant ${grant}: it contains ${root}`);
      }
    }
  }
  for (const grant of writable) {
    for (const target of guards.protectedPaths ?? []) {
      if (containsPath(grant, target)) {
        throw new MxcPolicyError(`refusing write access to ${grant}: it contains ${target}`);
      }
    }
  }
}

function normalizeWindowsPath(p: string): string {
  return p
    .replace(/\//g, '\\')
    .replace(/^\\\\\?\\/, '')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function isVolumeOrShareRoot(p: string): boolean {
  const n = normalizeWindowsPath(p);
  return /^[a-z]:$/.test(n) || /^\\\\[^\\]+(\\[^\\]+)?$/.test(n);
}

/** Whether `outer` is `inner` or one of its ancestors. */
function containsPath(outer: string, inner: string): boolean {
  const o = normalizeWindowsPath(outer);
  const i = normalizeWindowsPath(inner);
  return i === o || i.startsWith(`${o}\\`);
}

function pathKey(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase();
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = pathKey(p);
    if (!p || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * What a run's failure means when the container, not the script, refused it.
 * Returns null for an ordinary script failure.
 */
export function describeMxcLaunchFailure(exitCode: number, stderr: string): string | null {
  if (exitCode >>> 0 === STATUS_DLL_INIT_FAILED) {
    return 'the Windows sandbox could not start Node: this session has no desktop a container can use. Start gezel from a signed-in Windows session.';
  }
  // A malformed request is refused before anything starts, in plain text.
  const rejected = /^Request error\r?\n(.+)/.exec(stderr)?.[1];
  if (rejected) return `the Windows sandbox rejected its request: ${rejected.trim()}`;
  // Otherwise the launcher's error object is the last thing it writes, so
  // only a parse that runs to the end counts: a script that printed similar
  // JSON and kept going is not a launch failure.
  const tail = stderr.trimEnd();
  const at = tail.lastIndexOf('{"error":');
  if (at < 0) return null;
  try {
    const { error } = JSON.parse(tail.slice(at)) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof error?.code !== 'string') return null;
    const message = typeof error.message === 'string' ? error.message : 'no details';
    return `the Windows sandbox failed to start (${error.code}): ${message}`;
  } catch {
    return null;
  }
}

// ── Availability ──────────────────────────────────────────────────────────

export type WindowsMxcStatus = 'active' | 'disabled' | 'unavailable' | 'probing';

export interface WindowsMxcState {
  state: WindowsMxcStatus;
  reason?: string;
  tier?: string;
}

interface LauncherFingerprint {
  size: number;
  mtimeMs: number;
}

interface ProbeOutcome {
  ok: boolean;
  reason?: string;
  tier?: string;
  transient: boolean;
  at: number;
  launcher: LauncherFingerprint | null;
}

interface ProbeEntry {
  promise: Promise<ProbeOutcome>;
  outcome?: ProbeOutcome;
  attempts: number;
}

const probes = new Map<string, ProbeEntry>();
let enabledInConfig = true;

/** The Settings switch. Takes effect on the next run, without a restart. */
export function setWindowsMxcEnabled(enabled: boolean): void {
  enabledInConfig = enabled;
}

/**
 * Synchronous snapshot for decisions that cannot wait (the tool surface, MCP
 * child env). Starts the probe when nothing has, so a later call sees it.
 */
export function windowsMxcState(nodeBin = defaultSandboxNodeBin()): WindowsMxcState {
  const ready = preconditions();
  if ('state' in ready) return ready;
  const entry = probeEntry(ready.executor, nodeBin);
  return entry.outcome ? stateFromOutcome(entry.outcome) : { state: 'probing' };
}

export async function resolveWindowsMxcState(
  nodeBin = defaultSandboxNodeBin(),
): Promise<WindowsMxcState> {
  const ready = preconditions();
  if ('state' in ready) return ready;
  return stateFromOutcome(await probeEntry(ready.executor, nodeBin).promise);
}

export async function canApplyWindowsMxcSandbox(nodeBin: string): Promise<boolean> {
  return (await resolveWindowsMxcState(nodeBin)).state === 'active';
}

/**
 * The launcher to wrap one run with, or null when the container is not
 * active. A launcher that changed on disk since its probe is probed again
 * before anything runs under it.
 */
export async function windowsMxcLauncherForRun(nodeBin: string): Promise<string | null> {
  if ((await resolveWindowsMxcState(nodeBin)).state !== 'active') return null;
  const executor = resolveMxcExecutor();
  if (!executor) return null;
  const key = probeKey(executor, nodeBin);
  const probed = probes.get(key)?.outcome?.launcher;
  const current = fingerprint(executor);
  if (probed && current && probed.size === current.size && probed.mtimeMs === current.mtimeMs) {
    return executor;
  }
  log.warn('[sandbox] windows-mxc launcher changed since it was probed; probing again');
  probes.delete(key);
  return (await resolveWindowsMxcState(nodeBin)).state === 'active' ? executor : null;
}

/** A run failed in the launcher after a passing probe: probe again next time. */
export function invalidateWindowsMxcProbe(reason: string): void {
  if (probes.size === 0) return;
  log.warn(`[sandbox] windows-mxc probe invalidated: ${reason}`);
  probes.clear();
}

/** Test seam: forget probe results so a test can change `GEZEL_MXC_EXEC`. */
export function resetWindowsMxcProbeForTests(): void {
  probes.clear();
  enabledInConfig = true;
  launcherHome = null;
}

function preconditions(): WindowsMxcState | { executor: string } {
  if (process.platform !== 'win32') return { state: 'unavailable', reason: 'not Windows' };
  if (process.env[MXC_SWITCH_ENV]?.trim().toLowerCase() === 'off') {
    return { state: 'disabled', reason: `turned off by ${MXC_SWITCH_ENV}=off` };
  }
  if (!enabledInConfig) return { state: 'disabled', reason: 'turned off in Settings' };
  const executor = resolveMxcExecutor();
  if (!executor) {
    return { state: 'unavailable', reason: 'the Windows sandbox launcher is not installed' };
  }
  return { executor };
}

function stateFromOutcome(outcome: ProbeOutcome): WindowsMxcState {
  if (outcome.ok) return { state: 'active', ...(outcome.tier ? { tier: outcome.tier } : {}) };
  return {
    state: 'unavailable',
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.tier ? { tier: outcome.tier } : {}),
  };
}

function probeKey(executor: string, nodeBin: string): string {
  return `${executor}|${nodeBin}`;
}

function probeEntry(executor: string, nodeBin: string): ProbeEntry {
  const key = probeKey(executor, nodeBin);
  const existing = probes.get(key);
  if (existing && !shouldProbeAgain(existing)) return existing;
  const entry: ProbeEntry = {
    attempts: (existing?.attempts ?? 0) + 1,
    promise: probeWindowsMxc(executor, nodeBin).then((outcome) => {
      entry.outcome = outcome;
      return outcome;
    }),
  };
  probes.set(key, entry);
  return entry;
}

/** A timeout or a launcher that would not start may clear up; a refusal will not. */
function shouldProbeAgain(entry: ProbeEntry): boolean {
  const outcome = entry.outcome;
  return (
    !!outcome &&
    !outcome.ok &&
    outcome.transient &&
    entry.attempts < MAX_PROBE_ATTEMPTS &&
    Date.now() - outcome.at >= TRANSIENT_RETRY_MS
  );
}

function fingerprint(path: string): LauncherFingerprint | null {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Checks the boundary rather than trusting `--probe`: under LocalService in
 * Session 0, `--probe` reports a usable tier and node.exe then fails to start.
 * Runs without the permission model or the JS network neutralizer, so only
 * the container can produce the refusals it expects. Exit codes name the
 * check that failed.
 */
const MXC_PROBE_SCRIPT = [
  "const fs=require('node:fs'),net=require('node:net'),p=require('node:path');",
  'const [rw,ro,denied]=process.argv.slice(1);',
  "try{fs.writeFileSync(p.join(rw,'w.txt'),'ok')}catch{process.exit(11)}",
  "try{fs.readFileSync(p.join(ro,'ro.txt'))}catch{process.exit(12)}",
  "let roWritable=true;try{fs.writeFileSync(p.join(ro,'w.txt'),'x')}catch{roWritable=false}",
  'if(roWritable)process.exit(13);',
  "let deniedReadable=true;try{fs.readFileSync(p.join(denied,'denied.txt'))}catch{deniedReadable=false}",
  'if(deniedReadable)process.exit(14);',
  "const s=net.connect({host:'127.0.0.1',port:9});",
  "s.once('connect',()=>process.exit(15));",
  "s.once('error',e=>process.exit(['EACCES','EPERM'].includes(e.code)?0:16));",
  'setTimeout(()=>process.exit(17),3000);',
].join('');

const PROBE_FAILURES: Record<number, { reason: string; transient: boolean }> = {
  11: { reason: 'Node could not write inside its granted folder', transient: false },
  12: { reason: 'Node could not read a read-only grant', transient: false },
  13: { reason: 'a read-only grant was writable', transient: false },
  14: { reason: 'Node could read a file outside its grants', transient: false },
  15: { reason: 'Node reached host loopback', transient: false },
  16: { reason: 'the container did not refuse a raw socket', transient: false },
  17: { reason: 'the network check timed out', transient: true },
};

async function probeWindowsMxc(executor: string, nodeBin: string): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  const launcher = fingerprint(executor);
  const tier = await readMxcTier(executor);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gezel-mxc-probe-')));
  let outcome: Omit<ProbeOutcome, 'at' | 'launcher' | 'tier'>;
  try {
    const rw = join(root, 'rw');
    const ro = join(root, 'ro');
    const denied = join(root, 'denied');
    await Promise.all([mkdir(rw), mkdir(ro), mkdir(denied)]);
    await writeFile(join(ro, 'ro.txt'), 'ro', 'utf8');
    await writeFile(join(denied, 'denied.txt'), 'denied', 'utf8');
    const { command, args } = wrapForWindowsMxc(
      executor,
      {
        command: nodeBin,
        args: [...MXC_NODE_PATH_FLAGS, '-e', MXC_PROBE_SCRIPT, rw, ro, denied],
        cwd: rw,
        readwritePaths: [rw],
        readonlyPaths: [ro, nodeBin],
        env: containerEnvironment({}, rw),
        denyNet: true,
        timeoutMs: PROBE_TIMEOUT_MS,
      },
      { protectedPaths: [executor, nodeBin] },
    );
    const run = await runCaptured(command, args, PROBE_TIMEOUT_MS + 5_000);
    outcome = classifyProbe(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outcome = { ok: false, reason: `the probe could not run: ${message}`, transient: true };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  const elapsed = Date.now() - startedAt;
  const tierNote = tier ? `tier=${tier}, ` : '';
  if (outcome.ok) log.info(`[sandbox] windows-mxc available (${tierNote}${elapsed}ms probe)`);
  else
    log.warn(
      `[sandbox] windows-mxc unavailable (${tierNote}${elapsed}ms probe): ${outcome.reason}`,
    );
  return { ...outcome, ...(tier ? { tier } : {}), at: Date.now(), launcher };
}

function classifyProbe(run: CapturedRun): Omit<ProbeOutcome, 'at' | 'launcher' | 'tier'> {
  if (run.timedOut) return { ok: false, reason: 'the sandbox probe timed out', transient: true };
  if (run.spawnError) {
    return { ok: false, reason: `the launcher did not start: ${run.spawnError}`, transient: true };
  }
  if (run.code === 0) return { ok: true, transient: false };
  const known = run.code === null ? undefined : PROBE_FAILURES[run.code];
  if (known) return { ok: false, ...known };
  const launch = describeMxcLaunchFailure(run.code ?? -1, run.stderr);
  return {
    ok: false,
    reason: launch ?? `the probe exited ${run.code}: ${run.stderr.trim().slice(0, 300)}`,
    transient: false,
  };
}

async function readMxcTier(executor: string): Promise<string | undefined> {
  const run = await runCaptured(executor, ['--probe'], 10_000);
  try {
    const parsed = JSON.parse(run.stdout) as { tier?: unknown };
    return typeof parsed.tier === 'string' ? parsed.tier : undefined;
  } catch {
    return undefined;
  }
}

interface CapturedRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function runCaptured(command: string, args: string[], timeoutMs: number): Promise<CapturedRun> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...windowsHeadlessSpawnOptions(),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: err.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// ── Concurrency ───────────────────────────────────────────────────────────

let activeRuns = 0;
const waitingRuns: Array<() => void> = [];

function maxConcurrentRuns(): number {
  const configured = Number(process.env[MXC_MAX_CONCURRENT_ENV]);
  if (Number.isInteger(configured) && configured > 0) return configured;
  // 48 parallel containers started cleanly on a 24-core box; the cap is for
  // runaway fan-out, not for a measured limit.
  return Math.max(8, availableParallelism());
}

/**
 * Wait for a container slot. Resolves to a release function, or null when
 * the signal aborts first. Waiting does not count against the run's timeout.
 */
export function acquireWindowsMxcSlot(signal?: AbortSignal): Promise<(() => void) | null> {
  if (signal?.aborted) return Promise.resolve(null);
  if (activeRuns < maxConcurrentRuns()) {
    activeRuns += 1;
    return Promise.resolve(releaseOnce());
  }
  return new Promise((resolve) => {
    const grant = () => {
      signal?.removeEventListener('abort', onAbort);
      activeRuns += 1;
      resolve(releaseOnce());
    };
    const onAbort = () => {
      const index = waitingRuns.indexOf(grant);
      if (index >= 0) waitingRuns.splice(index, 1);
      resolve(null);
    };
    waitingRuns.push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function releaseOnce(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRuns -= 1;
    waitingRuns.shift()?.();
  };
}
