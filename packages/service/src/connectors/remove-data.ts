/**
 * What a connection downloaded, so removing it can take that too: its corpus
 * folder under artifacts (records, attachments, tables, pending actions) and
 * its records held in quarantine. Removing a connection keeps all of it
 * unless the person asks; for a feed or a social account the copy here may
 * be the only one left.
 *
 * Quarantine is shared by every connection of a type (`quarantine/<type>/`,
 * one `<hash8>.md` per held record, its attachments under
 * `attachments/<hash8>/`). When another connection of the same type remains,
 * only the held records this corpus lists in its `_flags.json` sidecars go.
 */

import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { resolveInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';

export interface ConnectionDataLocation {
  /** The project's artifacts root. */
  artifactsDir: string;
  /** The project's private quarantine root. */
  quarantineDir: string;
  /** The connection's artifact-relative corpus folder (`data/<name>`). */
  corpusDir: string;
  /** The connection's type id, which names its quarantine folder. */
  type: string;
  /** Corpus folders of the project's other connections. */
  otherCorpusDirs: string[];
  /** Whether another connection of the same type remains. */
  typeShared: boolean;
}

export interface StoredData {
  files: number;
  bytes: number;
}

const CORPUS_DIR = /^data\/[^/]/;
const TYPE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const HASH8 = /^[0-9a-f]{8}$/;

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function* walkFiles(dir: string): AsyncGenerator<{ path: string; size: number }> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(abs);
    else {
      const info = await lstat(abs).catch(() => null);
      if (info) yield { path: abs, size: info.size };
    }
  }
}

/** The ids of the records a corpus holds, from its `_flags.json` sidecars. */
async function corpusRecordHashes(corpusAbs: string): Promise<Set<string>> {
  const hashes = new Set<string>();
  for await (const file of walkFiles(corpusAbs)) {
    if (basename(file.path) !== '_flags.json') continue;
    try {
      const sidecar = JSON.parse(await readFile(file.path, 'utf8')) as Record<string, unknown>;
      for (const key of Object.keys(sidecar)) if (HASH8.test(key)) hashes.add(key);
    } catch {
      /* an unreadable sidecar lists nothing */
    }
  }
  return hashes;
}

/**
 * The files and folders a connection's data occupies. Throws, before
 * anything is touched, when the corpus folder is not a connection's own
 * (`data/<name>`) or another connection writes into it.
 */
export async function connectionDataTargets(where: ConnectionDataLocation): Promise<string[]> {
  const corpusDir = where.corpusDir.replace(/\/+$/, '');
  if (!CORPUS_DIR.test(corpusDir) || corpusDir.split('/').includes('..')) {
    throw new Error(`${corpusDir} is not a connection's own folder`);
  }
  if (!TYPE_ID.test(where.type)) throw new Error(`unexpected connector type id ${where.type}`);
  const shared = where.otherCorpusDirs.find((other) => overlaps(other, corpusDir));
  if (shared) {
    throw new Error(
      `Another connection saves into ${shared}, so its downloaded data cannot be deleted on its own.`,
    );
  }
  const targets: string[] = [];
  // A project that never synced has no artifacts folder to resolve against.
  const corpusAbs = (await exists(where.artifactsDir))
    ? await resolveInside(where.artifactsDir, corpusDir)
    : null;
  if (corpusAbs && (await exists(corpusAbs))) targets.push(corpusAbs);
  const heldRoot = join(where.quarantineDir, where.type);
  if (!(await exists(heldRoot))) return targets;
  if (!where.typeShared) {
    targets.push(await resolveInside(where.quarantineDir, where.type));
    return targets;
  }
  if (!corpusAbs || !targets.includes(corpusAbs)) return targets;
  for (const hash of await corpusRecordHashes(corpusAbs)) {
    for (const rel of [`${where.type}/${hash}.md`, `${where.type}/attachments/${hash}`]) {
      const abs = await resolveInside(where.quarantineDir, rel);
      if (await exists(abs)) targets.push(abs);
    }
  }
  return targets;
}

/** How many files, and how many bytes, the targets hold. */
export async function measureTargets(targets: string[]): Promise<StoredData> {
  const total: StoredData = { files: 0, bytes: 0 };
  for (const target of targets) {
    const info = await lstat(target).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory()) {
      total.files++;
      total.bytes += info.size;
      continue;
    }
    for await (const file of walkFiles(target)) {
      total.files++;
      total.bytes += file.size;
    }
  }
  return total;
}

/** Delete the targets; returns what they held. */
export async function deleteTargets(targets: string[]): Promise<StoredData> {
  const held = await measureTargets(targets);
  for (const target of targets) await rm(target, { recursive: true, force: true });
  return held;
}
