import { mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { projectLocalFilesDir } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import type { ChunkInput } from './index-store.js';
import { convertInSandbox } from './sandbox-convert.js';

/**
 * Document → markdown conversion via squisq, written into the `_files`
 * companion-folder convention:
 *
 *   <source>jobs/resume.docx  →  .gezel/files/jobs/resume.docx_files/resume.md
 *
 * squisq is browser-oriented and its OOXML importers run native parsers (jszip,
 * pdfjs, xmldom). Because attachments are untrusted, the actual parse runs
 * out-of-process in a sandbox (see sandbox-convert.ts / convert-worker.ts);
 * this module only owns the `_files` placement + chunking. DOCX/PDF importers
 * ship in the pinned squisq packages.
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
  /** Markdown path relative to the workspace (forward-slashed), for display. */
  mdRel: string;
}

/** Compute the `_files` companion paths for a source doc (relative path). */
export function docFilesPaths(workspaceDir: string, relPath: string): DocFilesPaths {
  const base = basename(relPath);
  const nameNoExt = base.replace(/\.[^.]+$/, '');
  const parent = dirname(relPath);
  const dir = join(
    projectLocalFilesDir(workspaceDir),
    parent === '.' ? '' : parent,
    `${base}_files`,
  );
  const mdPath = join(dir, `${nameNoExt}.md`);
  return { dir, mdPath, mdRel: relative(workspaceDir, mdPath).replaceAll('\\', '/') };
}

/** Write converted markdown into the `_files` folder; returns its paths. */
export async function writeConvertedMarkdown(
  workspaceDir: string,
  relPath: string,
  markdown: string,
): Promise<DocFilesPaths> {
  const paths = docFilesPaths(workspaceDir, relPath);
  await mkdir(paths.dir, { recursive: true });
  await writeFileAtomic(paths.mdPath, markdown);
  return paths;
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
