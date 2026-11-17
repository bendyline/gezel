/**
 * Shared connector writer — the single on-disk chokepoint for every driver.
 * Generalized from `mail/storage.ts:writeMessage`. Turns a `NormalizedRecord`
 * into a markdown file under the project's artifacts tree:
 *
 *   <artifacts>/<corpusDir>/<...dirSegments>/
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
 * artifact tree. The body runs through the content scanner; a quarantine
 * verdict diverts the raw body to the project's private quarantine folder
 * (`Store.projectQuarantineDir`, outside both the artifact tree and the
 * workspace) and writes only a stub to the corpus.
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { copyFileAtomic, writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { resolveInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { parseFrontmatter, withFrontmatter } from '../index-store/frontmatter.js';
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
  /** Project artifacts root where this connector's corpus lands. */
  storageDir: string;
  /** Gezel-private folder for quarantined raw bodies; never inside the workspace. */
  quarantineDir: string;
  /** Top dir under artifacts where this connector's corpus lands. */
  corpusDir: string;
  record: NormalizedRecord;
}

export interface WriteRecordResult {
  status: WriteStatus;
  /** Artifact-relative path of the record markdown, when one was written. */
  relPath?: string;
}

/**
 * A record file: `<ordinal>--<stem>--<hash8>.md`. Ordinals are padded to
 * three digits and grow past 999; a three-digit-only pattern once made every
 * record after the 999th in a directory invisible to refresh, prune and
 * sweep, and gave them all ordinal 1000. Import this, never copy it.
 */
export const RECORD_FILE_RE = /^(\d{3,})--.*--([0-9a-f]{8})\.md$/;

/**
 * Content identity of a record: hash of the domain frontmatter (key-sorted, so
 * insertion order doesn't matter) + body. A changed upstream record changes
 * this while `recordId` (the filename identity) stays put — that mismatch is
 * what triggers a refresh-in-place.
 */
export function contentHash(record: NormalizedRecord): string {
  const volatile = new Set(record.volatileKeys ?? []);
  const sortedFrontmatter = Object.fromEntries(
    Object.entries(record.frontmatter)
      .filter(([key]) => !volatile.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
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
async function existingRecords(dirAbs: string): Promise<{
  maxOrdinal: number;
  files: Map<string, { name: string; ordinal: string }>;
  /** How many record files use each ordinal; above 1 only in a damaged dir. */
  ordinalUse: Map<string, number>;
}> {
  const files = new Map<string, { name: string; ordinal: string }>();
  const ordinalUse = new Map<string, number>();
  let maxOrdinal = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(dirAbs);
  } catch {
    return { maxOrdinal: 0, files, ordinalUse };
  }
  for (const e of entries) {
    const m = RECORD_FILE_RE.exec(e);
    if (m) {
      maxOrdinal = Math.max(maxOrdinal, Number(m[1]));
      files.set(m[2]!, { name: e, ordinal: m[1]! });
      ordinalUse.set(m[1]!, (ordinalUse.get(m[1]!) ?? 0) + 1);
    }
  }
  return { maxOrdinal, files, ordinalUse };
}

/**
 * Directories written before ordinals could pass 999 hold several records
 * on ordinal 1000, sharing `attachments/1000/`. When one of them is written
 * again it moves to a fresh ordinal, and every record still on the shared
 * ordinal loses its content hash, so each is rewritten (attachments too) the
 * next time the source lists it. The shared folder is left in place: it may
 * hold the only copy of attachments for records the source never lists again.
 */
async function releaseSharedOrdinal(
  dirAbs: string,
  ordinal: string,
  files: Map<string, { name: string; ordinal: string }>,
): Promise<void> {
  const sidecar = await readSidecar(dirAbs);
  let dirty = false;
  for (const [hash8, file] of files) {
    if (file.ordinal !== ordinal || !sidecar[hash8]?.contentHash) continue;
    delete sidecar[hash8].contentHash;
    dirty = true;
  }
  if (dirty) await writeFileAtomic(join(dirAbs, '_flags.json'), JSON.stringify(sidecar, null, 2));
}

/**
 * Write one normalized record. Idempotent on unchanged content: a record whose
 * `recordId` AND content hash match an existing file is skipped; a matching
 * `recordId` with changed content is replaced in place (same ordinal, so the
 * attachment dir stays stable). Scans the body, quarantines-or-writes, injects
 * `trust`/`scan_action`, and manages attachments + the flags sidecar.
 */
export async function writeRecord(input: WriteRecordInput): Promise<WriteRecordResult> {
  const { storageDir, quarantineDir, corpusDir, record } = input;
  const recordHash8 = sha8(record.recordId);
  const hash = contentHash(record);

  const relDir = [corpusDir, ...record.dirSegments].join('/');
  const dirAbs = await resolveInside(storageDir, relDir);
  await mkdir(dirAbs, { recursive: true });

  const { maxOrdinal, files, ordinalUse } = await existingRecords(dirAbs);
  const prior = files.get(recordHash8);
  let refreshed = false;
  let ordinal: string;
  if (prior && (ordinalUse.get(prior.ordinal) ?? 0) > 1) {
    await releaseSharedOrdinal(dirAbs, prior.ordinal, files);
    await rm(join(dirAbs, prior.name), { force: true });
    ordinal = String(maxOrdinal + 1).padStart(3, '0');
    refreshed = true;
  } else if (prior) {
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
  const body = linkOwnAttachments(record.bodyMarkdown, ordinal, record.attachments);

  // Scan the (untrusted) body, and separately the text a reader sees before
  // the body: a subject, a sender's display name, an attachment's name. An
  // injection there reaches the frontmatter and every listing of the corpus.
  const verdict = contentScanner.scan({
    markdown: body,
    origin: record.scanOrigin,
    sourceRef: record.recordId,
  });
  const headerText = headerScanText(record);
  const header = headerText
    ? contentScanner.scan({
        markdown: headerText,
        origin: record.scanOrigin,
        sourceRef: record.recordId,
      })
    : null;
  const action = worstScanAction(verdict.action, header?.action);
  const flags = [...new Set([...verdict.flags, ...(header?.flags ?? [])])];

  const frontmatter: Record<string, string> = {
    ...record.frontmatter,
    trust: 'untrusted-external',
    scan_action: action,
    ...(flags.length ? { scan_flags: flags.join(', ') } : {}),
  };

  if (action === 'quarantine') {
    // Divert the raw body to quarantine (unindexed); index only a stub. Create
    // the dir before resolveInside so its realpath check has an existing base.
    const qDir = join(quarantineDir, record.quarantineNamespace);
    await mkdir(qDir, { recursive: true });
    const qAbs = await resolveInside(
      quarantineDir,
      `${record.quarantineNamespace}/${recordHash8}.md`,
    );
    await writeFileAtomic(qAbs, withFrontmatter(frontmatter, body));
    // The attachments are held with the body, outside the corpus: a held
    // message's files must not be one click away in the artifacts drawer.
    await writeAttachments(qDir, recordHash8, record.attachments);
    // When the hostile text is in the header itself, the corpus copy keeps
    // the record's shape but not those words.
    const headerHeld = header !== null && header.action !== 'pass';
    const stubFrontmatter = headerHeld ? withHeldHeader(frontmatter) : frontmatter;
    const label = headerHeld ? 'This record' : record.quarantineLabel;
    const stub = `${label} was held for safety review (flags: ${flags.join(', ') || 'injection'}). Its content is not indexed; the original is kept in gezel's private quarantine folder.`;
    await writeFileAtomic(
      await resolveInside(storageDir, relPath),
      withFrontmatter(stubFrontmatter, stub),
    );
    await updateSidecar(dirAbs, recordHash8, record, { contentHash: hash, file: fileName });
    return { status: 'quarantined', relPath };
  }

  await writeFileAtomic(
    await resolveInside(storageDir, relPath),
    withFrontmatter(frontmatter, verdict.cleaned),
  );
  await writeAttachments(dirAbs, ordinal, record.attachments);
  await updateSidecar(dirAbs, recordHash8, record, { contentHash: hash, file: fileName });
  return { status: refreshed ? 'refreshed' : 'written', relPath };
}

/** Frontmatter a person or a model reads before the body. */
const HEADER_KEYS = [
  'title',
  'subject',
  'summary',
  'description',
  'from',
  'author',
  'name',
  'organizer',
] as const;

/** The header text the writer scans with its own verdict, or '' when there is none. */
function headerScanText(record: NormalizedRecord): string {
  const parts: string[] = [];
  for (const key of HEADER_KEYS) {
    const value = record.frontmatter[key];
    if (value) parts.push(value);
  }
  for (const att of record.attachments ?? []) parts.push(att.filename);
  return parts.join('\n');
}

function withHeldHeader(frontmatter: Record<string, string>): Record<string, string> {
  const out = { ...frontmatter };
  for (const key of HEADER_KEYS) {
    if (out[key]) out[key] = '[held for safety review]';
  }
  return out;
}

const SCAN_RANK = { pass: 0, annotate: 1, quarantine: 2 } as const;

function worstScanAction(
  a: keyof typeof SCAN_RANK,
  b: keyof typeof SCAN_RANK | undefined,
): keyof typeof SCAN_RANK {
  return b !== undefined && SCAN_RANK[b] > SCAN_RANK[a] ? b : a;
}

/**
 * Point `](attachment:<name>)` links in a record body at that record's own
 * attachment folder, `attachments/<NNN>/<name>`, relative to the record file.
 * An adapter cannot know the ordinal the writer assigns, so it writes the
 * placeholder. Only names of attachments the record actually carries are
 * rewritten; anything else is left as written, so text from the source can
 * never point a link at another record's files.
 */
export function linkOwnAttachments(
  body: string,
  ordinal: string,
  attachments: NormalizedRecord['attachments'],
): string {
  if (!attachments?.length || !body.includes('](attachment:')) return body;
  const safeNames = new Map(attachments.map((a) => [a.filename, safeFilename(a.filename)]));
  return body.replace(/\]\(attachment:([^)\s]+)\)/g, (whole, name: string) => {
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      /* keep the raw form */
    }
    const safe = safeNames.get(decoded) ?? safeNames.get(name);
    return safe ? `](attachments/${ordinal}/${encodeURIComponent(safe)})` : whole;
  });
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
  /** Project artifacts root containing the corpus. */
  storageDir: string;
  /** Scope-level corpus dir to prune (the same dir records were written to). */
  corpusDir: string;
  /** `sha8(recordId)` of every record the source still returns. */
  keepHashes: Set<string>;
  /**
   * The listing covered only records dated in this range (ISO instants or
   * days): a record outside it, or with no readable `date`, is kept.
   */
  within?: { start: string; end: string };
}

export interface PruneResult {
  pruned: number;
}

export interface SweepInput {
  /** Project artifacts root containing the corpus. */
  storageDir: string;
  /** Scope-level corpus dir to walk (the same dir records were written to). */
  corpusDir: string;
  /**
   * Decide per record file. `relPath` is artifact-relative and uses `/`, in
   * the same form `writeRecord` returns, so a caller can keep one copy of a
   * record and drop the others.
   */
  remove: (recordHash8: string, relPath: string) => boolean;
}

/**
 * Remove record files a predicate selects. Walks the scope subtree, skipping
 * `_`-prefixed entries (the mutable surface) and `attachments/`; a removed
 * record loses its file, its attachment dir, and its sidecar entry. Ordinals
 * go sparse by design — `writeRecord` allocates from the max, not the count.
 */
export async function sweepRecords(input: SweepInput): Promise<{ removed: number }> {
  const corpusRel = input.corpusDir.replace(/\/+$/, '');
  const rootAbs = await resolveInside(input.storageDir, corpusRel);
  let removed = 0;

  async function walk(dirAbs: string, dirRel: string): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    let sidecar: Record<string, SidecarEntry> | null = null;
    let sidecarDirty = false;
    // An attachment folder goes with the last record on its ordinal; in a
    // directory damaged before ordinals could pass 999 several share one.
    const ordinalUse = new Map<string, number>();
    for (const entry of entries) {
      const ord = entry.isFile() ? RECORD_FILE_RE.exec(entry.name)?.[1] : undefined;
      if (ord) ordinalUse.set(ord, (ordinalUse.get(ord) ?? 0) + 1);
    }
    for (const entry of entries) {
      if (entry.name.startsWith('_')) continue;
      if (entry.isDirectory()) {
        if (entry.name !== 'attachments') {
          await walk(join(dirAbs, entry.name), `${dirRel}/${entry.name}`);
        }
        continue;
      }
      const m = RECORD_FILE_RE.exec(entry.name);
      if (!m || !input.remove(m[2]!, `${dirRel}/${entry.name}`)) continue;
      await rm(join(dirAbs, entry.name), { force: true });
      const left = (ordinalUse.get(m[1]!) ?? 1) - 1;
      ordinalUse.set(m[1]!, left);
      if (left <= 0) {
        await rm(join(dirAbs, 'attachments', m[1]!), { recursive: true, force: true });
      }
      sidecar ??= await readSidecar(dirAbs);
      if (m[2]! in sidecar) {
        delete sidecar[m[2]!];
        sidecarDirty = true;
      }
      removed++;
    }
    if (sidecar && sidecarDirty) {
      await writeFileAtomic(join(dirAbs, '_flags.json'), JSON.stringify(sidecar, null, 2));
    }
  }

  await walk(rootAbs, corpusRel);
  return { removed };
}

/**
 * Remove records the source no longer returns — mirror-completeness sources
 * only, and only after a pass that enumerated the full scope with zero errors
 * (the engine enforces those gates).
 */
export async function pruneRecords(input: PruneInput): Promise<PruneResult> {
  if (!input.within) {
    const { removed } = await sweepRecords({
      storageDir: input.storageDir,
      corpusDir: input.corpusDir,
      remove: (hash8) => !input.keepHashes.has(hash8),
    });
    return { pruned: removed };
  }
  // Bounded by dates: find the unlisted records first, then remove only
  // those whose own date falls inside what the listing covered.
  const startMs = Date.parse(input.within.start);
  const endMs = Date.parse(input.within.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { pruned: 0 };
  const unlisted: string[] = [];
  await sweepRecords({
    storageDir: input.storageDir,
    corpusDir: input.corpusDir,
    remove: (hash8, relPath) => {
      if (!input.keepHashes.has(hash8)) unlisted.push(relPath);
      return false;
    },
  });
  const inRange = new Set<string>();
  for (const relPath of unlisted) {
    const text = await readFile(await resolveInside(input.storageDir, relPath), 'utf8').catch(
      () => '',
    );
    const ms = Date.parse(parseFrontmatter(text).data.date ?? '');
    if (Number.isFinite(ms) && ms >= startMs && ms < endMs) inRange.add(relPath);
  }
  if (inRange.size === 0) return { pruned: 0 };
  const { removed } = await sweepRecords({
    storageDir: input.storageDir,
    corpusDir: input.corpusDir,
    remove: (_hash8, relPath) => inRange.has(relPath),
  });
  return { pruned: removed };
}
