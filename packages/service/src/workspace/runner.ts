import { OutputRingBuffer } from '../fs/ring.js';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { runInSandbox } from '../sandbox/runner.js';
import { WorkspaceWriteDeniedError } from './errors.js';

/**
 * Default wall-clock timeout for `run_nodejs_script`. Clamped in the
 * HTTP route per-project-override setting (30s floor, 30min ceiling).
 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Output cap for stdout + stderr — same 200KB the Playwright runner uses. */
const OUTPUT_CAP_BYTES = 200_000;

export interface RunWorkspaceScriptOptions {
  projectId: string;
  scriptPath: string;
  args?: string[];
  timeoutMs?: number;
}

export interface RunWorkspaceScriptResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  error?: string;
}

/**
 * Run a Node / TypeScript script that lives inside the project
 * workspace. The script has exactly:
 *
 *   - Read access to: workspace + project artifacts dir + any
 *     `node_modules/` below the workspace (so `pnpm install`ed deps
 *     resolve).
 *   - Write access to: workspace + artifacts.
 *   - No child_process / worker / addons (Node `--permission` denies).
 *   - No outbound network when an enforceable OS boundary is available.
 *     Today that is macOS Seatbelt. Windows/Linux fail closed instead of
 *     presenting Node's Permission Model as malicious-code containment.
 *   - A wall-clock timeout (default 5 min, configurable per-project).
 *   - Env scrubbed to an allowlist — no tokens leak in.
 *
 * Extensions are not restricted: a `.ts` / `.mts` / `.mjs` / `.js` /
 * `.cjs` file all run. Restricting extensions was security theater —
 * the runner is the fence, not the filename.
 */
export async function runWorkspaceScript(
  store: Store,
  opts: RunWorkspaceScriptOptions,
): Promise<RunWorkspaceScriptResult> {
  const gate = await store.assertWorkspaceWritable(opts.projectId);
  // `run_nodejs_script` requires workspace-write because scripts can
  // mutate files through the sandbox's fs-write permission. Even a
  // "read-only" script is denied on locked-down external projects —
  // consistent gating with the file tools, simpler mental model.
  if (!gate.ok) {
    throw new WorkspaceWriteDeniedError(gate);
  }

  const workspaceDir = gate.workspaceDir;
  const scriptAbs = safeJoin(workspaceDir, opts.scriptPath);
  if (!scriptAbs) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      error: `Script path escapes the workspace: ${opts.scriptPath}`,
    };
  }

  const artifactsDir = store.projectArtifactsDir(opts.projectId);
  const timeout = clampTimeout(opts.timeoutMs);
  const stdoutRing = new OutputRingBuffer(OUTPUT_CAP_BYTES);
  const stderrRing = new OutputRingBuffer(OUTPUT_CAP_BYTES);

  const res = await runInSandbox({
    entry: scriptAbs,
    cwd: workspaceDir,
    input: '',
    timeoutMs: timeout,
    extraReadPaths: [artifactsDir],
    stripTypes: true,
    denyNet: true,
    scriptArgs: opts.args ?? [],
    onStdout: (line) => stdoutRing.append(`${line}\n`),
    onStderr: (line) => stderrRing.append(`${line}\n`),
  });

  const stdout = stdoutRing.value();
  const stderr = stderrRing.value();

  return {
    ok: res.exitCode === 0 && !res.timedOut,
    code: res.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    timedOut: res.timedOut,
    ...(res.timedOut ? { error: `Script exceeded ${timeout}ms timeout and was killed.` } : {}),
  };
}

function clampTimeout(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  if (raw < 30_000) return 30_000;
  if (raw > 30 * 60_000) return 30 * 60_000;
  return Math.floor(raw);
}
