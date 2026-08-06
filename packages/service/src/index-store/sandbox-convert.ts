/**
 * Host side of out-of-process document conversion. Runs the cheap, structurally
 * safe pre-parse guards in-process (size cap, magic-byte sniff, zip-bomb guard —
 * none of these inflate or parse content), then hands the file to the sandboxed
 * `convert-worker` for the actual squisq parse. The risky parser only ever runs
 * in the network-denied, env-scrubbed, fs-scoped child.
 *
 * Fail-closed: if we cannot establish the sandbox (worker file or node_modules
 * root unresolvable), we DO NOT fall back to in-process parsing — conversion
 * simply returns null. Better to leave an attachment unconverted than to parse
 * untrusted bytes in the main process.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@bendyline/gezel';
import { guardZipArchive } from '../safety/archive-guard.js';
import { sniffContainer } from '../safety/sniff.js';
import { runInSandbox } from '../sandbox/runner.js';

const log = createLogger('convert');

/** Largest attachment we will even attempt to convert. */
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
/** OOXML (ZIP-container) extensions that get the zip-bomb guard. */
const ZIP_EXTS = new Set(['docx', 'pptx', 'xlsx']);

export interface SandboxConvertResult {
  /** Converted markdown, or null when unsupported / parse failed. */
  markdown: string | null;
  /** Set when refused for safety (size / type confusion / zip bomb / timeout). */
  blocked?: string;
}

/** Walk up from `start` to the topmost ancestor that contains a node_modules. */
function findRepoRoot(start: string): string | null {
  let dir = start;
  let highest: string | null = null;
  for (;;) {
    if (existsSync(join(dir, 'node_modules'))) highest = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return highest;
}

let readRootsCache: string[] | null | undefined;
/**
 * Read roots the sandboxed worker needs to resolve and load squisq + its deps.
 * Normally the package lives under the monorepo's node_modules, so a single
 * root suffices. In a linked workspace (dev), `@bendyline/squisq-formats`
 * realpaths to a sibling repo OUTSIDE node_modules — the worker still needs
 * read access there, so we grant that repo's root too. Returns null only when
 * squisq cannot be resolved at all (fail closed — see file header).
 */
function sandboxReadRoots(): string[] | null {
  if (readRootsCache !== undefined) return readRootsCache;
  const roots = new Set<string>();

  // The monorepo root whose node_modules (+ pnpm store) holds the worker's own
  // deps and the @bendyline/* workspace symlinks.
  const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  if (repoRoot) roots.add(repoRoot);

  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@bendyline/squisq-formats');
    // Installed: under node_modules (already covered by repoRoot). Linked
    // workspace: a sibling repo whose realpath sits outside node_modules.
    const linkedRoot = findRepoRoot(dirname(resolved));
    if (linkedRoot) roots.add(linkedRoot);
  } catch {
    readRootsCache = null;
    return null;
  }

  readRootsCache = roots.size > 0 ? [...roots] : null;
  return readRootsCache;
}

let workerCache: { path: string; stripTypes: boolean } | null | undefined;
/** Locate the convert-worker entry — built `.js` (prod) or source `.ts` (dev). */
function workerEntry(): { path: string; stripTypes: boolean } | null {
  if (workerCache !== undefined) return workerCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'index-store', 'convert-worker.js'), // prod: bundled into dist/index.js, here = dist
    join(here, 'convert-worker.js'), // emitted sibling
    join(here, 'convert-worker.ts'), // dev: sibling source under src/index-store
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      workerCache = { path, stripTypes: path.endsWith('.ts') };
      return workerCache;
    }
  }
  workerCache = null;
  return workerCache;
}

/**
 * Convert a document to markdown in the sandbox. `ext` is the lowercased
 * extension without a leading dot. Pre-parse guards run here; the parse runs in
 * the child.
 */
export async function convertInSandbox(
  absPath: string,
  ext: string,
): Promise<SandboxConvertResult> {
  let bytes: Buffer;
  try {
    const st = await stat(absPath);
    if (st.size > MAX_INPUT_BYTES) {
      return {
        markdown: null,
        blocked: `file exceeds the ${MAX_INPUT_BYTES}-byte conversion limit`,
      };
    }
    bytes = await readFile(absPath);
  } catch {
    return { markdown: null };
  }

  // Type-confusion / polyglot guard: the container must match the extension.
  const sniff = sniffContainer(bytes, ext);
  if (!sniff.matchesExtension) {
    return {
      markdown: null,
      blocked: `content is not a valid ${ext} file (looks like ${sniff.detected})`,
    };
  }

  // Zip-bomb guard for OOXML containers — inspect the central directory only.
  if (ZIP_EXTS.has(ext)) {
    const guard = guardZipArchive(bytes);
    if (!guard.ok) return { markdown: null, blocked: guard.reason ?? 'unsafe archive' };
  }

  const roots = sandboxReadRoots();
  const worker = workerEntry();
  if (!roots || !worker) {
    // Fail closed — never parse untrusted bytes in the main process.
    log.warn('sandbox unavailable (worker or node_modules root unresolved); skipping conversion');
    return { markdown: null };
  }

  // realpath the scratch dir: tmpdir() on macOS is a symlink, and node's
  // --permission --allow-fs-write is compared against the realpath.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'gezel-convert-')));
  try {
    const inputName = `input.${ext}`;
    await writeFile(join(scratch, inputName), bytes);
    const res = await runInSandbox({
      entry: worker.path,
      cwd: scratch,
      input: '',
      scriptArgs: [inputName, ext],
      stripTypes: worker.stripTypes,
      denyNet: true, // a parser never needs the network
      maxOldSpaceMb: 512, // bound a runaway / bomb allocation
      timeoutMs: 60_000, // a convert taking >60s is pathological
      relaxReads: true, // squisq + deps read from node_modules / brew / icu
      extraReadPaths: roots, // node_modules (incl. pnpm store) + linked workspace pkgs
    });
    if (res.timedOut) return { markdown: null, blocked: 'conversion timed out' };
    if (res.exitCode !== 0) {
      log.warn(
        `sandboxed ${ext} conversion failed (exit ${res.exitCode}): ${res.stderr || res.stdout || 'no worker output'}`,
      );
      return { markdown: null };
    }
    const md = await readFile(join(scratch, 'output.md'), 'utf8').catch(() => null);
    return { markdown: md };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
