/**
 * Shared connector writer — the single on-disk chokepoint for every driver.
 * Generalized from `mail/storage.ts:writeMessage`. Turns a `NormalizedRecord`
 * into an immutable markdown file under the project workspace, where the content
 * indexer picks it up for free:
 *
 *   <workspace>/<corpusDir>/<...dirSegments>/
 *     <NNN>--<fileStem>--<recordHash8>.md   (immutable)
 *     attachments/<NNN>/<safe-filename>      (original bytes)
 *     _flags.json                            (mutable sidecar)
 *
 * Security (inherited from mail verbatim): every path component derived from the
 * (attacker-controlled) source is slugged by the adapter AND every write goes
 * through `resolveInside`, so a hostile id / title / filename can't escape the
 * workspace. The body runs through the content scanner; a quarantine verdict
 * diverts the raw body to `.gezel/quarantine/<namespace>/` (outside any indexed
 * root) and indexes only a stub.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { projectLocalQuarantineDir } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
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

export type WriteStatus = 'written' | 'exists' | 'quarantined';

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

/** Count existing ordinal-prefixed record files in a dir + their content hashes. */
async function existingRecords(dirAbs: string): Promise<{ count: number; hashes: Set<string> }> {
  const hashes = new Set<string>();
  let count = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(dirAbs);
  } catch {
    return { count: 0, hashes };
  }
  for (const e of entries) {
    const m = /^\d{3}--.*--([0-9a-f]{8})\.md$/.exec(e);
    if (m) {
      count++;
      hashes.add(m[1]!);
    }
  }
  return { count, hashes };
}

/**
 * Write one normalized record. Idempotent: a record already present (matched by
 * its content hash) is skipped. Scans the body, quarantines-or-writes, injects
 * `trust`/`scan_action`, and manages attachments + the flags sidecar.
 */
export async function writeRecord(input: WriteRecordInput): Promise<WriteRecordResult> {
  const { workspaceDir, corpusDir, record } = input;
  const recordHash8 = sha8(record.recordId);

  const relDir = [corpusDir, ...record.dirSegments].join('/');
  const dirAbs = await resolveInside(workspaceDir, relDir);
  await mkdir(dirAbs, { recursive: true });

  // Idempotency: immutable records are never rewritten.
  const { count, hashes } = await existingRecords(dirAbs);
  if (hashes.has(recordHash8)) return { status: 'exists' };

  const ordinal = String(count + 1).padStart(3, '0');
  const fileName = `${ordinal}--${record.fileStem}--${recordHash8}.md`;
  const relPath = `${relDir}/${fileName}`;

  // Scan the (untrusted) body. Origin is cast until the scanner input widens
  // beyond mail's `email`/`attachment` union (Phase 4).
  const verdict = contentScanner.scan({
    markdown: record.bodyMarkdown,
    origin: record.scanOrigin as 'email' | 'attachment',
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
    await updateSidecar(dirAbs, recordHash8, record);
    return { status: 'quarantined', relPath };
  }

  await writeFileAtomic(
    await resolveInside(workspaceDir, relPath),
    withFrontmatter(frontmatter, verdict.cleaned),
  );
  await writeAttachments(dirAbs, ordinal, record.attachments);
  await updateSidecar(dirAbs, recordHash8, record);
  return { status: 'written', relPath };
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
    await writeFileAtomic(abs, att.content);
  }
}

/** Mutable per-record sidecar of read/flags state. Never indexed. */
async function updateSidecar(
  dirAbs: string,
  recordHash8: string,
  record: NormalizedRecord,
): Promise<void> {
  const path = join(dirAbs, '_flags.json');
  let current: Record<string, { read: boolean; flags: string[] }> = {};
  try {
    const { readFile } = await import('node:fs/promises');
    current = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    /* no sidecar yet */
  }
  current[recordHash8] = { read: record.seen ?? false, flags: record.flags ?? [] };
  await writeFileAtomic(path, JSON.stringify(current, null, 2));
}
