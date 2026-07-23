import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { runInSandbox } from '../sandbox/runner.js';

/**
 * ─ nodeRuns gate executor ────────────────────────────────────────────
 *
 * Executes a code deliverable in the sandbox for the `nodeRuns` gate
 * check: copy the file plus its RELATIVE-import closure into a scratch
 * dir, run it under the full sandbox fence (no child processes, no
 * network, strip-types), and report exit code + stderr tail. Only
 * dependency-free files can pass (node built-ins are fine — the scratch
 * has no npm tree); a bare-specifier import fails at load and the gate
 * message tells the author why.
 */

export interface NodeRunsResult {
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
}

const MAX_CLOSURE_FILES = 50;
const MAX_CLOSURE_BYTES = 2 * 1024 * 1024;
const STDERR_TAIL_LINES = 15;

const RELATIVE_SPEC_RE =
  /(?:\bimport\b[^'"()]*?\bfrom\s*|\bexport\b[^'"()]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];

/**
 * Collect the deliverable + everything it reaches through relative
 * imports (transitively), as workspace-relative paths. Best-effort and
 * capped — a closure that blows the caps is truncated, which surfaces as
 * a load failure with a clear message rather than a silent pass.
 */
async function collectClosure(
  read: (rel: string) => Promise<string | null>,
  entry: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let totalBytes = 0;
  const queue: string[] = [entry];
  while (queue.length > 0 && files.size < MAX_CLOSURE_FILES) {
    const rel = queue.shift()!;
    if (files.has(rel)) continue;
    const content = await read(rel);
    if (content === null) continue;
    totalBytes += content.length;
    if (totalBytes > MAX_CLOSURE_BYTES) break;
    files.set(rel, content);
    const dir = posix.dirname(rel);
    for (const m of content.matchAll(RELATIVE_SPEC_RE)) {
      const spec = m[1]!;
      const base = posix.normalize(posix.join(dir, spec));
      if (base.startsWith('..')) continue; // escapes the workspace — the sandbox couldn't read it anyway
      if (base.includes('node_modules')) continue;
      for (const suffix of RESOLVE_SUFFIXES) {
        const candidate = suffix === '' ? base : `${base}${suffix}`;
        if (files.has(candidate)) break;
        const exists = (await read(candidate)) !== null;
        if (exists) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return files;
}

export async function execNodeRunsInSandbox(opts: {
  read: (rel: string) => Promise<string | null>;
  file: string;
  timeoutMs: number;
}): Promise<NodeRunsResult> {
  const closure = await collectClosure(opts.read, opts.file);
  if (!closure.has(opts.file)) {
    return {
      exitCode: 1,
      stderrTail: `${opts.file} not found in the workspace`,
      timedOut: false,
    };
  }
  const raw = await mkdtemp(join(tmpdir(), 'gezel-noderuns-'));
  const scratch = await realpath(raw);
  try {
    for (const [rel, content] of closure) {
      const abs = join(scratch, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
    await writeFile(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'gezel-noderuns', type: 'module', private: true }),
    );
    const result = await runInSandbox({
      entry: opts.file,
      cwd: scratch,
      input: '',
      timeoutMs: opts.timeoutMs,
      stripTypes: true,
      denyNet: true,
      maxOldSpaceMb: 512,
      relaxReads: true,
    });
    const stderrTail = result.stderr.split('\n').slice(-STDERR_TAIL_LINES).join('\n').trim();
    return { exitCode: result.exitCode, stderrTail, timedOut: result.timedOut };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
