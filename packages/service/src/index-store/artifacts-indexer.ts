import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, nowIso } from '@bendyline/gezel';
import {
  CONNECTOR_TABLES_DIR_NAME,
  PROJECT_SHADOW_DIR_NAME,
  projectArtifactsIndexDbFile,
} from '@bendyline/gezel/paths';
import type { Store } from '../fs/store.js';
import { classifyFile, isDenseBlob } from './classify.js';
import { chunkMarkdown } from './docs.js';
import { parseFrontmatter } from './frontmatter.js';
import { sha256 } from './hash.js';
import { IndexStore } from './index-store.js';

/**
 * Indexes a project's artifact corpora — the normalized markdown records
 * connectors mirror under `artifacts/data/**` — into a per-project
 * `artifacts.db` collection so corpus content is searchable (docs FTS)
 * without ever entering the workspace content index. The database lives in
 * the account-private sidecar ({@link projectArtifactsIndexDbFile}), never
 * inside the artifacts tree, so it cannot surface in the corpus browser.
 *
 * Deterministic and offline, same discipline as the workspace static tier:
 * mtime+size gate, then content-hash gate, replace-by-file writes, prune of
 * vanished records. Only `.md` records are indexed; the corpus's mutable
 * `_`-prefixed surface (`_meta.json`, `_actions/`, `_flags.json`),
 * `attachments/` payloads, any reserved `shadow/` subtree, and the `tables/`
 * subtree of an observation corpus are skipped.
 */

const log = createLogger('index:artifacts');

/** Corpus records live under `<artifacts>/data/**` — the walk covers nothing else. */
const CORPUS_ROOT = 'data';

/**
 * Walk budget. Corpora are backfill-capped per scope, so a healthy project
 * stays far below this; a runaway tree logs loudly instead of indexing
 * forever (and a capped pass skips the removal sweep — see below).
 */
export const MAX_ARTIFACT_FILES = 20_000;

export interface ArtifactsIndexStats {
  /** Markdown records the walk saw (post-skip rules). */
  files: number;
  /** Records whose content was (re)ingested this pass. */
  indexed: number;
  /** Rows pruned because their record vanished. */
  removed: number;
}

/** Collection id for a project's artifacts corpus — distinct from the workspace collection. */
export function artifactsCollectionId(projectId: string): string {
  return `artifacts:${projectId}`;
}

/** Open (creating if needed) the project's artifacts-corpus IndexStore. */
export async function openArtifactsIndex(
  home: string,
  projectId: string,
  artifactsDir: string,
): Promise<IndexStore | null> {
  return IndexStore.open(projectArtifactsIndexDbFile(home, projectId), {
    collectionId: artifactsCollectionId(projectId),
    kind: 'generic',
    rootPath: artifactsDir,
  });
}

interface WalkedRecord {
  /** Artifacts-relative path with forward slashes, e.g. `data/mail/inbox/001--x.md`. */
  path: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/**
 * Bounded walk of `<artifactsDir>/data/**`. Skips `_`-prefixed entries (the
 * corpus's mutable surface), `attachments/` directories, and the reserved
 * `shadow/` subtree; collects `.md` files only. Dirents never follow
 * symlinks, so a planted link cannot pull the walk outside the corpus.
 */
async function walkCorpus(
  artifactsDir: string,
  maxFiles: number,
): Promise<{ records: WalkedRecord[]; capped: boolean }> {
  const records: WalkedRecord[] = [];
  const queue: string[] = [CORPUS_ROOT];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(join(artifactsDir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('_')) continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        // `tables/` holds observation corpora: partitioned Parquet and NDJSON,
        // never markdown. The `.md` filter below already excludes the files,
        // but descending would still `readdir` one directory per partition —
        // thousands on a busy corpus — on every pass, for nothing. Skipping at
        // the directory level is also what keeps log rows out of the vector
        // index, where near-identical text collapses the space and degrades
        // retrieval for the corpora that need it.
        if (
          e.name === 'attachments' ||
          e.name === PROJECT_SHADOW_DIR_NAME ||
          e.name === CONNECTOR_TABLES_DIR_NAME
        )
          continue;
        queue.push(childRel);
        continue;
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      if (records.length >= maxFiles) return { records, capped: true };
      try {
        const abs = join(artifactsDir, childRel);
        const s = await stat(abs);
        records.push({ path: childRel, abs, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        /* raced deletion — next pass settles it */
      }
    }
  }
  return { records, capped: false };
}

/**
 * Bring one already-open artifacts collection up to date against the corpus
 * tree. Frontmatter is lifted into `metadata` (filterable), the body is
 * chunked into the docs FTS — the same treatment workspace markdown gets,
 * minus symbols (nothing fans out to `find_symbol` over corpora).
 */
export async function indexArtifactsContent(
  store: IndexStore,
  artifactsDir: string,
  maxFiles = MAX_ARTIFACT_FILES,
): Promise<ArtifactsIndexStats> {
  const stats: ArtifactsIndexStats = { files: 0, indexed: 0, removed: 0 };
  const seen = new Set<string>();
  const indexedAt = nowIso();

  const { records, capped } = await walkCorpus(artifactsDir, maxFiles);
  if (capped) {
    log.warn(
      `artifacts corpus walk hit the ${maxFiles}-record cap under ${artifactsDir}; later records are not indexed this pass and the removal sweep is skipped`,
    );
  }

  for (const file of records) {
    stats.files++;
    seen.add(file.path);

    const existing = store.getFile(file.path);
    // Cheap change gate: same mtime + size ⇒ unchanged, no read/hash.
    if (existing && existing.mtimeMs === file.mtimeMs && existing.size === file.size) continue;

    let content: string;
    try {
      content = await readFile(file.abs, 'utf8');
    } catch {
      continue;
    }
    const hash = sha256(content);
    const loc = content.split(/\r?\n/).length;
    const cls = classifyFile(file.path, file.size);
    const record = {
      path: file.path,
      hash,
      size: file.size,
      mtimeMs: file.mtimeMs,
      lang: cls.lang,
      kind: cls.kind,
      modality: cls.modality,
      trivial: cls.trivial || isDenseBlob(file.size, loc),
      indexedAt,
      loc,
    };
    // Content unchanged despite an mtime touch — just refresh the stat row.
    if (existing && existing.hash === hash) {
      store.upsertFile(record);
      continue;
    }
    stats.indexed++;
    store.upsertFile(record);
    if (record.trivial) continue;

    const { data, body } = parseFrontmatter(content);
    const entries = Object.entries(data).map(([key, value]) => ({ key, value }));
    if (entries.length > 0) store.setMetadata(file.path, entries);
    store.putChunks(file.path, hash, chunkMarkdown(body));
  }

  // Prune rows whose record vanished — but never off a capped walk, where
  // `seen` under-represents the corpus and the sweep would drop live rows.
  if (!capped) {
    for (const f of store.allFiles()) {
      if (!seen.has(f.path)) {
        store.deleteFile(f.path);
        stats.removed++;
      }
    }
  }
  return stats;
}

/**
 * Convenience: open the project's artifacts collection, index, and close.
 * Returns null when sqlite is unavailable. A project with no corpus and no
 * existing database is a zero-stat no-op — no empty `artifacts.db` is minted
 * for connector-less projects.
 */
export async function indexProjectArtifacts(
  store: Store,
  home: string,
  projectId: string,
): Promise<ArtifactsIndexStats | null> {
  const artifactsDir = store.projectArtifactsDir(projectId);
  const hasCorpus = await stat(join(artifactsDir, CORPUS_ROOT)).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!hasCorpus && !existsSync(projectArtifactsIndexDbFile(home, projectId))) {
    return { files: 0, indexed: 0, removed: 0 };
  }
  const index = await openArtifactsIndex(home, projectId, artifactsDir);
  if (!index) return null;
  try {
    return await indexArtifactsContent(index, artifactsDir);
  } finally {
    index.close();
  }
}
