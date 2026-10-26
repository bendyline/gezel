import { readFile } from 'node:fs/promises';
import {
  type EgressIndicator,
  egressIndicatorRefusal,
  findEgressIndicators,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { OutputRingBuffer } from '../fs/ring.js';
import type { Store } from '../fs/store.js';
import { denyNetBoundaryAvailable, runInSandbox } from '../sandbox/runner.js';
import { WorkspaceWriteDeniedError } from './errors.js';
import { restoreGatedManifestEdits, snapshotRootManifests } from './manifest-guard.js';

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
  /** Set when the script was refused before it ran; the route records it in History. */
  egressIndicators?: EgressIndicator[];
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
 *   - No outbound network wherever an OS boundary can enforce that (macOS
 *     Seatbelt, a probed Linux systemd user service). Elsewhere it fails
 *     closed rather than presenting Node's Permission Model as malicious-code
 *     containment — unless External services is on (see
 *     {@link workspaceScriptDeniesNetwork}).
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
  // Node resolves a script's module type from the nearest package.json; with
  // none in the workspace it would read the project's private one above it.
  await store.ensureWorkspaceTemplate(opts.projectId);

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

  const source = await readFile(scriptAbs, 'utf8').catch(() => '');
  const egressIndicators = findEgressIndicators(source);
  if (egressIndicators.length > 0) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      error: egressIndicatorRefusal(egressIndicators),
      egressIndicators,
    };
  }

  const artifactsDir = store.projectArtifactsDir(opts.projectId);
  const timeout = clampTimeout(opts.timeoutMs);
  const stdoutRing = new OutputRingBuffer(OUTPUT_CAP_BYTES);
  const stderrRing = new OutputRingBuffer(OUTPUT_CAP_BYTES);
  const manifests = await snapshotRootManifests(workspaceDir);

  const res = await runInSandbox({
    entry: scriptAbs,
    cwd: workspaceDir,
    input: '',
    timeoutMs: timeout,
    extraReadPaths: [artifactsDir],
    stripTypes: true,
    denyNet: await workspaceScriptDeniesNetwork(store),
    scriptArgs: opts.args ?? [],
    onStdout: (line) => stdoutRing.append(`${line}\n`),
    onStderr: (line) => stderrRing.append(`${line}\n`),
  });
  const restoredNote = await restoreGatedManifestEdits(store, workspaceDir, manifests);
  if (restoredNote) stderrRing.append(`${restoredNote}\n`);

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

/**
 * Whether a gezel-written script (`run_nodejs_script`, `derive_file`) runs
 * behind the deny-network boundary. Always where the OS can enforce one.
 * Where it cannot, a denyNet run fails closed, so the script gets the network
 * only when the policy already lets gezellen reach it (External services) —
 * the same condition under which gezel-mcp registers these tools there.
 */
export async function workspaceScriptDeniesNetwork(store: Store): Promise<boolean> {
  if (await denyNetBoundaryAvailable()) return true;
  return !resolveSecurityPolicy(await store.readConfig()).allowExternalServices;
}

function clampTimeout(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  if (raw < 30_000) return 30_000;
  if (raw > 30 * 60_000) return 30 * 60_000;
  return Math.floor(raw);
}
