import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { PROJECT_SHADOW_DIR_NAME } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import { realpathContained, safeJoin } from '../fs/safe-paths.js';
import type { ChunkInput } from './index-store.js';
import { convertInSandbox } from './sandbox-convert.js';

/**
 * Document → markdown conversion via squisq, written into the `_files`
 * companion-folder convention. Workspace sources shadow into the project's
 * artifacts tree — never the workspace itself, which may be read-only:
 *
 *   <workspace>docs/architecture.docx
 *     →  <artifacts>/shadow/docs/architecture.docx_files/architecture.md
 *
 * The companion dir is keyed by the FULL basename (extension kept): stem
 * keying made `a.docx` and `a.pdf` collide on one `a_files/a.md`, and the
 * full name gives orphan GC a lossless reverse map (`X_files` → source `X`).
 * Artifact/document previews keep the user-visible adjacent placement
 * ({@link adjacentDocFilesPaths}), which stays stem-keyed for continuity.
 *
 * squisq is browser-oriented and its OOXML importers run native parsers (jszip,
 * pdfjs, xmldom). Because attachments are untrusted, the actual parse runs
 * out-of-process in a sandbox (see sandbox-convert.ts / convert-worker.ts);
 * this module only owns placement + chunking. DOCX/PDF importers ship in the
 * pinned squisq packages.
 */

const MAX_CHUNK_CHARS = 4000;

/**
 * Extensions squisq can import to markdown. The sandbox worker guards each
 * function so an older linked squisq checkout simply returns null for an
 * unsupported format.
 */
const CONVERTIBLE = new Set(['docx', 'pdf', 'pptx', 'xlsx']);

/** True when we have a squisq importer for this extension today. */
export function isConvertibleDoc(ext: string): boolean {
  return CONVERTIBLE.has(ext.replace(/^\./, '').toLowerCase());
}

export interface DocConversion {
  /** Converted markdown, or null when the format is unsupported / parse failed. */
  markdown: string | null;
  /**
   * Set when the file was refused by a safety check (oversized, type confusion,
   * zip bomb, or a parse that timed out in the sandbox). The caller indexes a
   * stub note rather than the (absent) content so the user can see it arrived.
   */
  blocked?: string;
}

/**
 * Convert a binary document at `absPath` to markdown. Parsing happens in the
 * sandbox; pre-parse safety guards happen on the host. Best-effort — the caller
 * records the source file regardless of the outcome.
 */
export async function convertDocToMarkdown(absPath: string): Promise<DocConversion> {
  const ext = extname(absPath).replace(/^\./, '').toLowerCase();
  if (!isConvertibleDoc(ext)) return { markdown: null };
  return convertInSandbox(absPath, ext);
}

export interface DocFilesPaths {
  /** Absolute `_files` companion directory. */
  dir: string;
  /** Absolute path of the converted markdown. */
  mdPath: string;
  /** Markdown path relative to the sidecar's source root (forward-slashed). */
  mdRel: string;
}

/**
 * Companion paths for a workspace source inside the project's reserved
 * `artifacts/shadow/` tree. The source relPath is untrusted workspace input,
 * so the whole companion path is built through `safeJoin`; null means the
 * name cannot be shadowed safely (traversal, reserved Windows name, ADS) and
 * the caller simply skips conversion.
 */
export function shadowDocFilesPaths(artifactsDir: string, relPath: string): DocFilesPaths | null {
  const base = basename(relPath);
  const nameNoExt = base.replace(/\.[^.]+$/, '') || base;
  const parent = dirname(relPath);
  const relMd = join(parent === '.' ? '' : parent, `${base}_files`, `${nameNoExt}.md`);
  const shadowRoot = join(artifactsDir, PROJECT_SHADOW_DIR_NAME);
  const mdPath = safeJoin(shadowRoot, relMd);
  if (!mdPath) return null;
  return {
    dir: dirname(mdPath),
    mdPath,
    mdRel: relative(artifactsDir, mdPath).replaceAll('\\', '/'),
  };
}

/**
 * Compute a user-visible companion beside a source tree:
 * `decks/brief.pptx` → `decks/brief_files/brief.md`.
 *
 * Artifacts and the shared documents library use this placement. Workspace
 * conversions use {@link shadowDocFilesPaths} instead, so derived files land
 * in the project's artifacts tree rather than a possibly read-only workspace.
 */
export function adjacentDocFilesPaths(sourceRoot: string, relPath: string): DocFilesPaths {
  const base = basename(relPath);
  const nameNoExt = base.replace(/\.[^.]+$/, '');
  const parent = dirname(relPath);
  const dir = join(sourceRoot, parent === '.' ? '' : parent, `${nameNoExt}_files`);
  const mdPath = join(dir, `${nameNoExt}.md`);
  return { dir, mdPath, mdRel: relative(sourceRoot, mdPath).replaceAll('\\', '/') };
}

/** Write markdown to an already-computed companion path. */
export async function writeConvertedMarkdownAt(
  paths: DocFilesPaths,
  markdown: string,
): Promise<DocFilesPaths> {
  await mkdir(paths.dir, { recursive: true });
  await writeFileAtomic(paths.mdPath, markdown);
  return paths;
}

export interface EnsuredDocSidecar extends DocConversion {
  paths: DocFilesPaths;
}

/**
 * Return a fresh markdown companion, converting and atomically refreshing it
 * when the source is newer. The mtime gate keeps reopening a deck cheap while
 * the conversion itself remains in the sandboxed worker.
 */
export async function ensureConvertedMarkdownSidecar(
  sourcePath: string,
  paths: DocFilesPaths,
): Promise<EnsuredDocSidecar> {
  let sourceMtimeMs: number;
  try {
    sourceMtimeMs = (await stat(sourcePath)).mtimeMs;
  } catch {
    return { markdown: null, paths };
  }

  const sidecarStat = await stat(paths.mdPath).catch(() => null);
  if (sidecarStat?.isFile() && sidecarStat.mtimeMs >= sourceMtimeMs) {
    const markdown = await readFile(paths.mdPath, 'utf8').catch(() => null);
    if (markdown !== null) return { markdown, paths };
  }

  const converted = await convertDocToMarkdown(sourcePath);
  if (converted.markdown !== null) {
    await writeConvertedMarkdownAt(paths, converted.markdown);
  }
  return { ...converted, paths };
}

/**
 * Ensure the shadow-tree markdown companion for a workspace source doc.
 * Null when the source name cannot map to a safe shadow path or the computed
 * companion escapes the shadow root through a symlink. Concurrent callers
 * (static worker, `read_doc_as_markdown`, the References preview) may race on
 * one sidecar; `writeFileAtomic`'s rename makes that last-writer-wins with no
 * torn reads — worst case is a wasted duplicate conversion.
 */
export async function ensureShadowDocSidecar(
  sourceAbs: string,
  artifactsDir: string,
  relPath: string,
): Promise<EnsuredDocSidecar | null> {
  const paths = shadowDocFilesPaths(artifactsDir, relPath);
  if (!paths) return null;
  const shadowRoot = join(artifactsDir, PROJECT_SHADOW_DIR_NAME);
  // The root must exist before the symlink check: realpathContained refuses
  // when its base is missing, and the first conversion of a project is
  // exactly the moment nothing exists yet. Our own cache dir — safe to make.
  await mkdir(shadowRoot, { recursive: true }).catch(() => {});
  if (!(await realpathContained(shadowRoot, paths.mdPath))) return null;
  return ensureConvertedMarkdownSidecar(sourceAbs, paths);
}

/**
 * Split converted markdown into section chunks (by heading) for FTS + later
 * embeddings. Falls back to a single capped chunk when there are no headings.
 */
export function chunkMarkdown(md: string): ChunkInput[] {
  const lines = md.split(/\r?\n/);
  const headIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) headIdx.push(i);
  }
  const cap = (s: string) => (s.length > MAX_CHUNK_CHARS ? s.slice(0, MAX_CHUNK_CHARS) : s);
  const out: ChunkInput[] = [];
  if (headIdx.length === 0) {
    const text = md.trim();
    return text ? [{ kind: 'doc', lineStart: 1, lineEnd: lines.length, text: cap(text) }] : [];
  }
  if (headIdx[0]! > 0) {
    const text = lines.slice(0, headIdx[0]).join('\n').trim();
    if (text) out.push({ kind: 'preamble', lineStart: 1, lineEnd: headIdx[0]!, text: cap(text) });
  }
  for (let h = 0; h < headIdx.length; h++) {
    const start = headIdx[h]!;
    const end = h + 1 < headIdx.length ? headIdx[h + 1]! - 1 : lines.length - 1;
    const text = lines
      .slice(start, end + 1)
      .join('\n')
      .trim();
    if (text)
      out.push({ kind: 'section', lineStart: start + 1, lineEnd: end + 1, text: cap(text) });
  }
  return out;
}
