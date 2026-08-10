/**
 * Shared connector writer — the single on-disk chokepoint for every driver.
 * Generalized from `mail/storage.ts:writeMessage`. Turns a `NormalizedRecord`
 * into a markdown file under the project workspace, where the content indexer
 * picks it up for free:
 *
 *   <workspace>/<corpusDir>/<...dirSegments>/
 *     <NNN>--<fileStem>--<recordHash8>.md   (refresh-in-place: replaced when
 *                                            upstream content changes, ordinal
 *                                            + record identity stable)
 *     attachments/<NNN>/<safe-filename>      (original bytes)
 *     _flags.json                            (mutable sidecar: read/flags state
 *                                            + the content hash driving refresh)
 *
 * The corpus tracks the CURRENT state of upstream: a record whose `recordId`
 * already exists is skipped when its content hash matches and replaced in
 * place when it differs; `pruneRecords` (mirror sources only) removes records
 * the source no longer returns. Only connector code mutates the corpus —
 * gezels are read-only here.
 *
 * Security (inherited from mail verbatim): every path component derived from the
 * (attacker-controlled) source is slugged by the adapter AND every write goes
 * through `resolveInside`, so a hostile id / title / filename can't escape the
 * workspace. The body runs through the content scanner; a quarantine verdict
 * diverts the raw body to `.gezel/quarantine/<namespace>/` (outside any indexed
 * root) and indexes only a stub.
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { projectLocalQuarantineDir } from '@bendyline/gezel/paths';
import { copyFileAtomic, writeFileAtomic } from '../fs/atomic.js';
import { resolveInside } from '../fs/safe-paths.js';
import { withFrontmatter } from '../index-store/frontmatter.js';
import { contentScanner } from '../safety/index.js';
import type { NormalizedRecord } from './types.js';

export const sha8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** Lowercase kebab slug, ASCII-only, bounded length, never empty. */
export function slug(input: string, max = 48): string {
  const s = input
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'x';
}

/** Sanitize an attachment filename to a single safe path segment. */
function safeFilename(name: string): string {
  const base = basename(name)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control characters from filenames.
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 200) : 'attachment';
}

export type WriteStatus = 'written' | 'refreshed' | 'exists' | 'quarantined';

export interface WriteRecordInput {
  workspaceDir: string;
  /** Top dir under the workspace where this connector's corpus lands (mail: `mail`). */
  corpusDir: string;
  record: NormalizedRecord;
}

export interface WriteRecordResult {
  status: WriteStatus;
  /** Workspace-relative path of the record markdown, when one was written. */
  relPath?: string;
}

const RECORD_FILE_RE = /^(\d{3})--.*--([0-9a-f]{8})\.md$/;

/**
 * Content identity of a record: hash of the domain frontmatter (key-sorted, so
 * insertion order doesn't matter) + body. A changed upstream record changes
 * this while `recordId` (the filename identity) stays put — that mismatch is
 * what triggers a refresh-in-place.
 */
export function contentHash(record: NormalizedRecord): string {
  const sortedFrontmatter = Object.fromEntries(
    Object.entries(record.frontmatter).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const attachments = (record.attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    size: attachment.size ?? attachment.content?.byteLength ?? 0,
    sha256: attachment.sha256 ?? createHash('sha256').update(attachment.content!).digest('hex'),
  }));
  return sha8(
    `${JSON.stringify(sortedFrontmatter)}\n${record.bodyMarkdown}\n${JSON.stringify(attachments)}`,
  );
}

/** Existing ordinal-prefixed record files in a dir, by record hash. */
async function existingRecords(
  dirAbs: string,
): Promise<{ maxOrdinal: number; files: Map<string, { name: string; ordinal: string }> }> {
  const files = new Map<string, { name: string; ordinal: string }>();
  let maxOrdinal = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(dirAbs);
  } catch {
    return { maxOrdinal: 0, files };
  }
  for (const e of entries) {
    const m = RECORD_FILE_RE.exec(e);
    if (m) {
      maxOrdinal = Math.max(maxOrdinal, Number(m[1]));
      files.set(m[2]!, { name: e, ordinal: m[1]! });
    }
  }
  return { maxOrdinal, files };
}

/**
 * Write one normalized record. Idempotent on unchanged content: a record whose
 * `recordId` AND content hash match an existing file is skipped; a matching
 * `recordId` with changed content is replaced in place (same ordinal, so the
 * attachment dir stays stable). Scans the body, quarantines-or-writes, injects
 * `trust`/`scan_action`, and manages attachments + the flags sidecar.
 */
export async function writeRecord(input: WriteRecordInput): Promise<WriteRecordResult> {
  const { workspaceDir, corpusDir, record } = input;
  const recordHash8 = sha8(record.recordId);
  const hash = contentHash(record);

  const relDir = [corpusDir, ...record.dirSegments].join('/');
  const dirAbs = await resolveInside(workspaceDir, relDir);
  await mkdir(dirAbs, { recursive: true });

  const { maxOrdinal, files } = await existingRecords(dirAbs);
  const prior = files.get(recordHash8);
  let refreshed = false;
  let ordinal: string;
  if (prior) {
    const sidecar = await readSidecar(dirAbs);
    // A missing sidecar hash (pre-refresh corpus) counts as changed — the
    // record is rewritten once and carries a hash from then on.
    if (sidecar[recordHash8]?.contentHash === hash) return { status: 'exists' };
    ordinal = prior.ordinal;
    await rm(join(dirAbs, prior.name), { force: true });
    await rm(join(dirAbs, 'attachments', ordinal), { recursive: true, force: true });
    refreshed = true;
  } else {
    ordinal = String(maxOrdinal + 1).padStart(3, '0');
  }
  const fileName = `${ordinal}--${record.fileStem}--${recordHash8}.md`;
  const relPath = `${relDir}/${fileName}`;

  // Scan the (untrusted) body.
  const verdict = contentScanner.scan({
    markdown: record.bodyMarkdown,
    origin: record.scanOrigin,
    sourceRef: record.recordId,
  });

  const frontmatter: Record<string, string> = {
    ...record.frontmatter,
    trust: 'untrusted-external',
    scan_action: verdict.action,
    ...(verdict.flags.length ? { scan_flags: verdict.flags.join(', ') } : {}),
  };

  if (verdict.action === 'quarantine') {
    // Divert the raw body to quarantine (unindexed); index only a stub. Create
    // the dir before resolveInside so its realpath check has an existing base.
    const qBase = projectLocalQuarantineDir(workspaceDir);
    await mkdir(join(qBase, record.quarantineNamespace), { recursive: true });
    const qAbs = await resolveInside(qBase, `${record.quarantineNamespace}/${recordHash8}.md`);
    await writeFileAtomic(qAbs, withFrontmatter(frontmatter, record.bodyMarkdown));
    const stub = `${record.quarantineLabel} was held for safety review (flags: ${verdict.flags.join(', ') || 'injection'}). Its content is not indexed. See \`.gezel/quarantine/${record.quarantineNamespace}/${recordHash8}.md\`.`;
    await writeFileAtomic(
      await resolveInside(workspaceDir, relPath),
      withFrontmatter(frontmatter, stub),
    );
    await writeAttachments(dirAbs, ordinal, record.attachments);
    await updateSidecar(dirAbs, recordHash8, record, { contentHash: hash, file: fileName });
    return { status: 'quarantined', relPath };
  }

  await writeFileAtomic(
    await resolveInside(workspaceDir, relPath),
    withFrontmatter(frontmatter, verdict.cleaned),
  );
  await writeAttachments(dirAbs, ordinal, record.attachments);
  await updateSidecar(dirAbs, recordHash8, record, { contentHash: hash, file: fileName });
  return { status: refreshed ? 'refreshed' : 'written', relPath };
}

async function writeAttachments(
  dirAbs: string,
  ordinal: string,
  attachments: NormalizedRecord['attachments'],
): Promise<void> {
  if (!attachments?.length) return;
  for (const att of attachments) {
    const rel = `attachments/${ordinal}/${safeFilename(att.filename)}`;
    const abs = await resolveInside(dirAbs, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    if (att.sourcePath !== undefined) {
      const info = await stat(att.sourcePath);
      if (!info.isFile())
        throw new Error(`connector attachment source is not a file: ${att.filename}`);
      if (info.size !== att.size) {
        throw new Error(
          `connector attachment size changed before publish: ${att.filename} ` +
            `(expected ${att.size}, found ${info.size})`,
        );
      }
      await copyFileAtomic(att.sourcePath, abs);
    } else {
      await writeFileAtomic(abs, att.content);
    }
  }
}

interface SidecarEntry {
  read: boolean;
  flags: string[];
  /** Content identity backing refresh-in-place. Absent on pre-refresh corpora. */
  contentHash?: string;
  /** Current record filename (tracks refreshes without re-listing the dir). */
  file?: string;
}

/** Read a dir's `_flags.json` sidecar ({} when absent or unreadable). */
async function readSidecar(dirAbs: string): Promise<Record<string, SidecarEntry>> {
  try {
    return JSON.parse(await readFile(join(dirAbs, '_flags.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Mutable per-record sidecar of read/flags state. Never indexed. */
async function updateSidecar(
  dirAbs: string,
  recordHash8: string,
  record: NormalizedRecord,
  identity: { contentHash: string; file: string },
): Promise<void> {
  const current = await readSidecar(dirAbs);
  current[recordHash8] = {
    read: record.seen ?? false,
    flags: record.flags ?? [],
    contentHash: identity.contentHash,
    file: identity.file,
  };
  await writeFileAtomic(join(dirAbs, '_flags.json'), JSON.stringify(current, null, 2));
}

export interface PruneInput {
  workspaceDir: string;
  /** Scope-level corpus dir to prune (the same dir records were written to). */
  corpusDir: string;
  /** `sha8(recordId)` of every record the source still returns. */
  keepHashes: Set<string>;
}

export interface PruneResult {
  pruned: number;
}

/**
 * Remove records the source no longer returns — mirror-completeness sources
 * only, and only after a pass that enumerated the full scope with zero errors
 * (the engine enforces those gates). Walks the scope subtree, skipping
 * `_`-prefixed entries (the mutable surface) and `attachments/`; a pruned
 * record loses its file, its attachment dir, and its sidecar entry. Ordinals
 * go sparse by design — `writeRecord` allocates from the max, not the count.
 */
export async function pruneRecords(input: PruneInput): Promise<PruneResult> {
  const rootAbs = await resolveInside(input.workspaceDir, input.corpusDir);
  let pruned = 0;

  async function walk(dirAbs: string): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    let sidecar: Record<string, SidecarEntry> | null = null;
    let sidecarDirty = false;
    for (const entry of entries) {
      if (entry.name.startsWith('_')) continue;
      if (entry.isDirectory()) {
        if (entry.name !== 'attachments') await walk(join(dirAbs, entry.name));
        continue;
      }
      const m = RECORD_FILE_RE.exec(entry.name);
      if (!m || input.keepHashes.has(m[2]!)) continue;
      await rm(join(dirAbs, entry.name), { force: true });
      await rm(join(dirAbs, 'attachments', m[1]!), { recursive: true, force: true });
      sidecar ??= await readSidecar(dirAbs);
      if (m[2]! in sidecar) {
        delete sidecar[m[2]!];
        sidecarDirty = true;
      }
      pruned++;
    }
    if (sidecar && sidecarDirty) {
      await writeFileAtomic(join(dirAbs, '_flags.json'), JSON.stringify(sidecar, null, 2));
    }
  }

  await walk(rootAbs);
  return { pruned };
}
