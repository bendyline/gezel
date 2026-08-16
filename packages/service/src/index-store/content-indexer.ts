import type { Dirent } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { nowIso } from '@bendyline/gezel';
import { PROJECT_SHADOW_DIR_NAME, projectLocalIndexDbFile } from '@bendyline/gezel/paths';
import { isLibraryInternalPath } from '../fs/sync-junk.js';
import { indexFileSecurity } from '../security/extract.js';
import { discoverWorkspaceFiles } from '../workspace/file-walk.js';
import { classifyFile, isDenseBlob } from './classify.js';
import {
  chunkMarkdown,
  ensureShadowDocSidecar,
  isConvertibleDoc,
  shadowDocFilesPaths,
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
 * v3: html/css/vue/svelte classify as code — existing rows hold the old
 *     'other' kind, and only this bump re-extracts them (the mtime/size gate
 *     would otherwise keep an unchanged index.html unreviewable forever).
 */
const EXTRACTOR_VERSION = 3;

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
 * Returns stats. Pure structural tier: files + symbols. `artifactsDir` is the
 * project's artifacts root — converted-document shadows land under its
 * reserved `shadow/` subtree, never inside the (possibly read-only) workspace.
 */
export async function indexWorkspaceContent(
  store: IndexStore,
  workspaceDir: string,
  artifactsDir: string,
  opts: { scope?: 'workspace' | 'library' } = {},
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

  const walkedFiles = await discoverWorkspaceFiles(workspaceDir, {
    maxFiles: MAX_FILES,
    // The shared document library is a user folder, not a source tree: it
    // holds outside-in companion twins (a derived markdown view of a
    // document already in the listing) and whatever a cloud-sync client
    // leaves behind. Indexing either produces a second, worse hit for the
    // same document.
    ...(opts.scope === 'library' ? { ignorePath: isLibraryInternalPath } : {}),
  });
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

    if (cls.modality === 'audio') {
      // Deterministic audio tier: hash the bytes and index a filename-derived
      // chunk so recordings are findable by name immediately. The transcript
      // shadow is added later by the AI-shadow tier when STT is available.
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
      const nameWords = file.path
        .replace(/\.[^.]+$/, '')
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .join(' ');
      store.putChunks(file.path, hash, [
        { kind: 'audio', lineStart: 1, lineEnd: 1, text: `${nameWords} audio recording` },
      ]);
      continue;
    }

    if (cls.modality === 'doc') {
      // Binary document: hash the bytes (gate on content), convert to markdown
      // via squisq into the artifacts `shadow/` tree, and chunk the markdown
      // for FTS. `doc:convert` metadata remembers the last outcome so a
      // blocked/unconvertible doc is not re-attempted every pass, while a
      // successful conversion whose sidecar vanished (deleted cache, pre-shadow
      // install) self-heals here.
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
      const convertible = isConvertibleDoc(extname(file.path));
      if (existing && existing.hash === hash) {
        store.upsertFile(record);
        if (!convertible) continue;
        const paths = shadowDocFilesPaths(artifactsDir, file.path);
        const sidecarPresent = paths
          ? await stat(paths.mdPath).then(
              (s) => s.isFile(),
              () => false,
            )
          : true;
        if (sidecarPresent) continue;
        const state = store.getMetadata(file.path)['doc:convert'];
        if (state && state !== 'ok') continue;
        const conv = await ensureShadowDocSidecar(file.abs, artifactsDir, file.path);
        // Chunks stay untouched: same content hash, and re-chunking would
        // orphan the existing chunk embeddings.
        store.setMetadata(file.path, [{ key: 'doc:convert', value: convState(conv) }]);
        if (conv?.markdown != null) stats.docsConverted++;
        continue;
      }
      stats.changed++;
      store.upsertFile(record);
      if (convertible) {
        const conv = await ensureShadowDocSidecar(file.abs, artifactsDir, file.path);
        store.setMetadata(file.path, [{ key: 'doc:convert', value: convState(conv) }]);
        if (conv?.markdown != null) {
          store.putChunks(file.path, hash, chunkMarkdown(conv.markdown));
          stats.docsConverted++;
        } else if (conv?.blocked) {
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

  // Prune files that disappeared; their shadow companions go with them.
  for (const f of store.allFiles()) {
    if (!seen.has(f.path)) {
      store.deleteFile(f.path);
      stats.removed++;
      if (isConvertibleDoc(extname(f.path))) {
        const paths = shadowDocFilesPaths(artifactsDir, f.path);
        if (paths) await rm(paths.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  await sweepShadowOrphans(artifactsDir, seen);

  // Stamp only after a complete walk so an interrupted forced pass retries.
  if (forceCode) store.setMeta('extractor_version', String(EXTRACTOR_VERSION));

  return stats;
}

const SHADOW_SWEEP_MAX_DIRS = 50_000;

/**
 * Delete shadow companion dirs whose source no longer exists — renames, a
 * crash between DB prune and dir delete, or sources dropped by the walk cap.
 * `seen` is this pass's live source set; a companion dir's name IS its source
 * basename plus `_files`, so the reverse map is lossless. Own walk, no depth
 * cap (GC must reach what the budgeted listing walker never shows), and
 * Dirents never follow symlinks so a planted link cannot recurse the sweep
 * outside the shadow root.
 */
async function sweepShadowOrphans(artifactsDir: string, seen: ReadonlySet<string>): Promise<void> {
  const shadowRoot = join(artifactsDir, PROJECT_SHADOW_DIR_NAME);
  const queue: string[] = [''];
  let visited = 0;
  while (queue.length > 0) {
    const rel = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(join(shadowRoot, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (++visited > SHADOW_SWEEP_MAX_DIRS) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.endsWith('_files')) {
        const sourceRel = childRel.slice(0, -'_files'.length);
        if (!seen.has(sourceRel)) {
          await rm(join(shadowRoot, childRel), { recursive: true, force: true }).catch(() => {});
        }
      } else {
        queue.push(childRel);
      }
    }
  }
}

function convState(conv: { markdown: string | null; blocked?: string } | null): string {
  if (conv?.markdown != null) return 'ok';
  if (conv?.blocked) return 'blocked';
  return 'failed';
}

/**
 * Convenience: open the workspace collection store, index, and close. Used by
 * tests and one-shot callers. Returns null stats when sqlite is unavailable.
 */
export async function runWorkspaceContentIndex(
  workspaceDir: string,
  collectionId: string,
  artifactsDir: string,
): Promise<ContentIndexStats | null> {
  await ensureIndexGitignore(workspaceDir);
  const store = await IndexStore.open(projectLocalIndexDbFile(workspaceDir), {
    collectionId,
    kind: 'workspace',
    rootPath: workspaceDir,
  });
  if (!store) return null;
  try {
    return await indexWorkspaceContent(store, workspaceDir, artifactsDir);
  } finally {
    store.close();
  }
}
