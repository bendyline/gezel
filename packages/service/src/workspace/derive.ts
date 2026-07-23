import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataTableSniff } from '@bendyline/gezel/checks';
import { OutputRingBuffer } from '../fs/ring.js';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { runInSandbox } from '../sandbox/runner.js';
import { WorkspaceWriteDeniedError } from './errors.js';

/**
 * Backs the `derive_file` MCP tool: produce a data file by EXECUTING a
 * model-supplied Node script instead of hand-emitting the bytes through
 * `writeFile.content`. Token emission is the wrong transport for
 * precision artifacts (the DS4 v15 lesson: an 18-minute hand-serialized
 * JSON still had wrong rows; the same transform as a script passed at
 * 10% of the budget) — this makes transform-by-execution engine-
 * agnostic instead of a llama-cpp prompt-matching mode.
 *
 * Security envelope is exactly `run_nodejs_script`'s: same sandbox
 * (`--permission` fs scoping, denyNet, env scrub, wall-clock kill), same
 * workspace-writable gate, same `code-execution` toolset membership (so
 * the `allowScriptExecution` policy strip applies). The only new
 * property: the script source arrives inline and runs from a scratch
 * dir OUTSIDE the workspace — it never persists as a workspace file.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_CAP_BYTES = 200_000;
const HEAD_PREVIEW_CHARS = 400;

/** Output extensions verified with the data-table sniff after the run. */
const DATA_OUTPUT_RE = /\.(csv|tsv|json|ndjson)$/i;

export interface DeriveWorkspaceFileOptions {
  projectId: string;
  /** Complete Node.js (ESM) source; reads/writes via `node:fs`, paths relative to the workspace root. */
  script: string;
  /** Workspace-relative file the script must produce. */
  outputPath: string;
  timeoutMs?: number;
}

export interface DeriveWorkspaceFileResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  /** Present when the script exited 0 AND the output verified. */
  output?: { path: string; bytes: number; headPreview: string };
  /** Script ran clean but the output failed verification (missing/empty/unparseable). */
  verifyError?: string;
  error?: string;
}

export async function deriveWorkspaceFile(
  store: Store,
  opts: DeriveWorkspaceFileOptions,
): Promise<DeriveWorkspaceFileResult> {
  const gate = await store.assertWorkspaceWritable(opts.projectId);
  if (!gate.ok) {
    throw new WorkspaceWriteDeniedError(gate);
  }
  const workspaceDir = gate.workspaceDir;

  // The output must land inside the workspace — a traversal in
  // `outputPath` is a hard error, not a fallback.
  const outputAbs = safeJoin(workspaceDir, opts.outputPath);
  if (!outputAbs) {
    return {
      ...emptyRun(),
      error: `Output path escapes the workspace: ${opts.outputPath}`,
    };
  }

  const timeout = clampTimeout(opts.timeoutMs);
  const stdoutRing = new OutputRingBuffer(OUTPUT_CAP_BYTES);
  const stderrRing = new OutputRingBuffer(OUTPUT_CAP_BYTES);
  const artifactsDir = store.projectArtifactsDir(opts.projectId);

  // `tmpdir()` is often `/var/...` on macOS while Node's permission
  // checks compare the resolved `/private/var/...` path. Match
  // runInSandbox's own scratch-dir realpathing so the inline entry file
  // remains readable under `--permission`.
  const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'gezel-derive-')));
  let res: Awaited<ReturnType<typeof runInSandbox>>;
  try {
    const entry = join(scratchDir, 'derive.mjs');
    await writeFile(entry, opts.script, 'utf8');
    res = await runInSandbox({
      entry,
      cwd: workspaceDir,
      input: '',
      timeoutMs: timeout,
      extraReadPaths: [scratchDir, artifactsDir],
      stripTypes: true,
      denyNet: true,
      scriptArgs: [],
      onStdout: (line) => stdoutRing.append(`${line}\n`),
      onStderr: (line) => stderrRing.append(`${line}\n`),
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }

  const stdout = mergeRunOutput(stdoutRing.value(), res.stdout);
  const stderr = mergeRunOutput(stderrRing.value(), res.stderr);
  const base: DeriveWorkspaceFileResult = {
    ok: false,
    code: res.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    timedOut: res.timedOut,
  };

  if (res.timedOut) {
    return { ...base, error: `Script exceeded ${timeout}ms timeout and was killed.` };
  }
  if (res.exitCode !== 0) {
    return base;
  }

  // The script's exit 0 is not the contract — the OUTPUT is. Verify it
  // landed, is non-empty, and (for data extensions) parses as a table so
  // "ran clean, wrote garbage" fails loudly at the tool boundary instead
  // of at the gate three turns later.
  const content = await store
    .readProjectWorkspaceFile(opts.projectId, opts.outputPath)
    .catch(() => null);
  if (content === null) {
    return {
      ...base,
      verifyError: `${opts.outputPath} was not created — the script must fs.writeFileSync the output itself.`,
    };
  }
  if (content.trim().length === 0) {
    return { ...base, verifyError: `${opts.outputPath} is empty.` };
  }
  if (DATA_OUTPUT_RE.test(opts.outputPath) && !dataTableSniff(content)) {
    return {
      ...base,
      verifyError: `${opts.outputPath} does not parse as a data table (expected a non-empty JSON array, delimited rows with a header, or a Markdown table).`,
    };
  }
  return {
    ...base,
    ok: true,
    output: {
      path: opts.outputPath,
      bytes: Buffer.byteLength(content, 'utf8'),
      headPreview: content.slice(0, HEAD_PREVIEW_CHARS),
    },
  };
}

function emptyRun(): Omit<DeriveWorkspaceFileResult, 'output' | 'verifyError' | 'error'> {
  return {
    ok: false,
    code: -1,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
  };
}

function clampTimeout(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  if (raw < 30_000) return 30_000;
  if (raw > 30 * 60_000) return 30 * 60_000;
  return Math.floor(raw);
}

function mergeRunOutput(
  ring: { text: string; truncated: boolean },
  raw: string,
): { text: string; truncated: boolean } {
  if (raw.length === 0 || ring.text === raw) return ring;
  const merged = `${ring.text}${raw}`;
  if (Buffer.byteLength(merged, 'utf8') <= OUTPUT_CAP_BYTES) {
    return { text: merged, truncated: ring.truncated };
  }
  const tail = Buffer.from(merged, 'utf8').subarray(-OUTPUT_CAP_BYTES).toString('utf8');
  return { text: tail, truncated: true };
}
