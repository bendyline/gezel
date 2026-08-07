import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { nowIso } from '@bendyline/gezel';
import { projectLocalIndexDbFile } from '@bendyline/gezel/paths';
import { indexFileSecurity } from '../security/extract.js';
import { discoverWorkspaceFiles } from '../workspace/file-walk.js';
import { classifyFile, isDenseBlob } from './classify.js';
import {
  chunkMarkdown,
  docFilesPaths,
  ensureConvertedMarkdownSidecar,
  isConvertibleDoc,
} from './docs.js';
import { parseFrontmatter } from './frontmatter.js';
import { ensureIndexGitignore } from './gitignore.js';
import { sha256 } from './hash.js';
import { readImageStaticMeta } from './image-meta.js';
import { IndexStore } from './index-store.js';
import {
  extractCodeSymbols,
  extractImportEdges,
  extractMarkdownOutline,
  isCodeLangSupported,
} from './symbols.js';

/**
 * Walks a workspace and brings its content index up to date: classify every
 * file, gate on (mtime, size) then content-hash so unchanged files do zero work,
 * and for changed code/markdown files extract symbols into the IndexStore. This
 * is the deterministic structural tier (Phase 1) — no LLM, fully offline.
 */

/** Generous safety cap so a runaway tree can't index forever. */
const MAX_FILES = 50_000;

/**
 * Bump when the structural extraction OUTPUT SHAPE changes (new columns, new
 * per-file derivations). Hash gating means existing rows never re-extract on
 * their own; a version mismatch forces one full re-extract pass over CODE
 * files (docs/images keep their gates — no re-conversion). The stamp is
 * written only after a complete walk, so an interrupted pass redoes next tick
 * (idempotent: all per-file writes are replace-by-file).
 * v2: named import bindings on dependency edges.
 */
const EXTRACTOR_VERSION = 2;

/**
 * PNG text keys worth putting in the search index, in priority order. Skips
 * ComfyUI's `workflow`, which is a whole serialized node graph — megabytes of
 * JSON that would swamp the FTS table without making anything findable.
 */
const INDEXED_PNG_TEXT_KEYS = ['parameters', 'prompt', 'Description', 'Comment', 'Title'];
const MAX_INDEXED_PNG_TEXT = 2000;

function embeddablePngText(text: Record<string, string> | undefined): string {
  if (!text) return '';
  const parts: string[] = [];
  let budget = MAX_INDEXED_PNG_TEXT;
  for (const key of INDEXED_PNG_TEXT_KEYS) {
    const value = text[key];
    if (!value || budget <= 0) continue;
    parts.push(value.slice(0, budget));
    budget -= value.length;
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export interface ContentIndexStats {
  scanned: number;
  changed: number;
  symbols: number;
  docsConverted: number;
  removed: number;
  skipped: number;
}

/**
 * Index (or refresh) one already-open collection store against `workspaceDir`.
 * Returns stats. Pure structural tier: files + symbols.
 */
export async function indexWorkspaceContent(
  store: IndexStore,
  workspaceDir: string,
): Promise<ContentIndexStats> {
  const stats: ContentIndexStats = {
    scanned: 0,
    changed: 0,
    symbols: 0,
    docsConverted: 0,
    removed: 0,
    skipped: 0,
  };
  const seen = new Set<string>();
  const indexedAt = nowIso();
  const forceCode = store.getMeta('extractor_version') !== String(EXTRACTOR_VERSION);

  const walkedFiles = await discoverWorkspaceFiles(workspaceDir, { maxFiles: MAX_FILES });
  for (const file of walkedFiles) {
    stats.scanned++;
    seen.add(file.path);

    const cls = classifyFile(file.path, file.size);
    const forceThis = forceCode && cls.kind === 'code';

    const existing = store.getFile(file.path);
    // Cheap change gate: same mtime + size ⇒ unchanged, no read/hash.
    if (
      !forceThis &&
      existing &&
      existing.mtimeMs === file.mtimeMs &&
      existing.size === file.size
    ) {
      stats.skipped++;
      continue;
    }

    if (cls.trivial) {
      // Record the file (so deletions/later phases see it) but do no content work.
      store.upsertFile({
        path: file.path,
        hash: null,
        size: file.size,
        mtimeMs: file.mtimeMs,
        lang: cls.lang,
        kind: cls.kind,
        modality: cls.modality,
        trivial: cls.trivial,
        indexedAt,
        loc: null,
      });
      continue;
    }

    if (cls.modality === 'image') {
      // Deterministic image tier (Phase 5): hash, read dimensions, and index a
      // filename-derived chunk so images are searchable by name immediately.
      // Captions + CLIP vectors are added later by the boekwachter when idle.
      let bytes: Buffer;
      try {
        bytes = await readFile(file.abs);
      } catch {
        stats.skipped++;
        continue;
      }
      const hash = sha256(bytes);
      const record = {
        path: file.path,
        hash,
        size: file.size,
        mtimeMs: file.mtimeMs,
        lang: cls.lang,
        kind: cls.kind,
        modality: cls.modality,
        trivial: cls.trivial,
        indexedAt,
        loc: null,
      };
      if (existing && existing.hash === hash) {
        store.upsertFile(record);
        continue;
      }
      stats.changed++;
      store.upsertFile(record);
      const meta = readImageStaticMeta(bytes);
      const metaRows: Array<{ key: string; value: string }> = [
        { key: 'format', value: meta.format },
      ];
      if (meta.width) metaRows.push({ key: 'width', value: String(meta.width) });
      if (meta.height) metaRows.push({ key: 'height', value: String(meta.height) });
      if (meta.likelyScreenshot) metaRows.push({ key: 'screenshot', value: '1' });
      const software = meta.pngText?.Software ?? meta.exif?.software;
      if (software) metaRows.push({ key: 'software', value: software });
      store.setMetadata(file.path, metaRows);
      const nameWords = file.path
        .replace(/\.[^.]+$/, '')
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .join(' ');
      const dimText = meta.width
        ? ` ${meta.format} ${meta.width}x${meta.height}`
        : ` ${meta.format}`;
      // Generation provenance is the one piece of image text we get for free:
      // A1111 writes `parameters`, ComfyUI writes `prompt`/`workflow`. Folding
      // it in makes generated images findable by what they were asked to be,
      // long before any captioning model runs.
      const provenance = embeddablePngText(meta.pngText);
      store.putChunks(file.path, hash, [
        {
          kind: 'image',
          lineStart: 1,
          lineEnd: 1,
          text: `${nameWords}${dimText}${provenance}`,
        },
      ]);
      continue;
    }

    if (cls.modality === 'doc') {
      // Binary document: hash the bytes (gate on content), convert to markdown
      // via squisq into the `_files` folder, and chunk the markdown for FTS.
      let bytes: Buffer;
      try {
        bytes = await readFile(file.abs);
      } catch {
        stats.skipped++;
        continue;
      }
      const hash = sha256(bytes);
      const record = {
        path: file.path,
        hash,
        size: file.size,
        mtimeMs: file.mtimeMs,
        lang: cls.lang,
        kind: cls.kind,
        modality: cls.modality,
        trivial: cls.trivial,
        indexedAt,
        loc: null,
      };
      if (existing && existing.hash === hash) {
        store.upsertFile(record);
        continue;
      }
      stats.changed++;
      store.upsertFile(record);
      if (isConvertibleDoc(extname(file.path))) {
        const conv = await ensureConvertedMarkdownSidecar(
          file.abs,
          docFilesPaths(workspaceDir, file.path),
        );
        if (conv.markdown != null) {
          store.putChunks(file.path, hash, chunkMarkdown(conv.markdown));
          stats.docsConverted++;
        } else if (conv.blocked) {
          // Refused for safety — index a stub so the file is visible/searchable
          // as "held" without its (unconverted) content entering the index.
          store.putChunks(file.path, hash, [
            {
              kind: 'doc',
              lineStart: 1,
              lineEnd: 1,
              text: `[Attachment held for safety: ${conv.blocked}. Not converted.]`,
            },
          ]);
        }
      }
      continue;
    }

    let content: string;
    try {
      content = await readFile(file.abs, 'utf8');
    } catch {
      stats.skipped++;
      continue;
    }
    const hash = sha256(content);
    const loc = content.split(/\r?\n/).length;
    // Machine-generated blob (minified bundle, icon data table): record it
    // like any trivial file — visible on the map, but no symbols/chunks and
    // no LLM enrichment call wasted on unsummarizable data.
    const trivial = cls.trivial || isDenseBlob(file.size, loc);

    // Content unchanged despite mtime touch — just refresh the stat row.
    if (!forceThis && existing && existing.hash === hash) {
      store.upsertFile({
        path: file.path,
        hash,
        size: file.size,
        mtimeMs: file.mtimeMs,
        lang: cls.lang,
        kind: cls.kind,
        modality: cls.modality,
        trivial,
        indexedAt,
        loc,
      });
      continue;
    }

    stats.changed++;
    store.upsertFile({
      path: file.path,
      hash,
      size: file.size,
      mtimeMs: file.mtimeMs,
      lang: cls.lang,
      kind: cls.kind,
      modality: cls.modality,
      trivial,
      indexedAt,
      loc,
    });

    if (trivial) {
      continue;
    }
    if (cls.kind === 'code' && isCodeLangSupported(cls.lang)) {
      const syms = await extractCodeSymbols(cls.lang!, content);
      if (syms) {
        store.putSymbols(file.path, hash, syms);
        stats.symbols += syms.length;
      }
      // Dependency edges (the map's "roads"); best-effort, resolved at build time.
      const edges = await extractImportEdges(cls.lang!, content);
      if (edges) store.putImports(file.path, hash, edges);
    } else if (cls.kind === 'markdown') {
      // Lift YAML frontmatter into metadata (email from/to/date, etc.) so it's
      // filterable; outline for code-intel; chunk the body so the document is
      // searchable via search_docs (this is how source-adapter mirrors —
      // emails, etc. — become searchable "for free").
      const { data, body } = parseFrontmatter(content);
      const entries = Object.entries(data).map(([key, value]) => ({ key, value }));
      if (entries.length > 0) store.setMetadata(file.path, entries);
      const syms = extractMarkdownOutline(content);
      store.putSymbols(file.path, hash, syms);
      stats.symbols += syms.length;
      store.putChunks(file.path, hash, chunkMarkdown(body));
    }

    // Built-in security signals for any code file (regex + entropy — cheap, and
    // independent of tree-sitter grammar support). Empty result clears stale
    // findings for a now-clean file.
    if (cls.kind === 'code') {
      indexFileSecurity(store, file.path, hash, content);
    }
  }

  // Prune files that disappeared.
  for (const f of store.allFiles()) {
    if (!seen.has(f.path)) {
      store.deleteFile(f.path);
      stats.removed++;
    }
  }

  // Stamp only after a complete walk so an interrupted forced pass retries.
  if (forceCode) store.setMeta('extractor_version', String(EXTRACTOR_VERSION));

  return stats;
}

/**
 * Convenience: open the workspace collection store, index, and close. Used by
 * tests and one-shot callers. Returns null stats when sqlite is unavailable.
 */
export async function runWorkspaceContentIndex(
  workspaceDir: string,
  collectionId: string,
): Promise<ContentIndexStats | null> {
  await ensureIndexGitignore(workspaceDir);
  const store = await IndexStore.open(projectLocalIndexDbFile(workspaceDir), {
    collectionId,
    kind: 'workspace',
    rootPath: workspaceDir,
  });
  if (!store) return null;
  try {
    return await indexWorkspaceContent(store, workspaceDir);
  } finally {
    store.close();
  }
}
