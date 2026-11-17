/**
 * The checks a live connection must pass, over a daemon's HTTP API: shared by
 * the run against a daemon a person started (`live-acceptance.test.ts`) and
 * the nightly run against an in-process daemon bound from exported test
 * accounts (`live-accounts.integration.test.ts`).
 *
 * Per binding: syncs until a backfill finishes (paging adapters may need
 * several passes) with no hard error; the corpus satisfies the connector
 * invariants (trust frontmatter, filename grammar, sidecars, nothing outside
 * the corpus root); `_meta.json` names the binding; records carry their
 * family's frontmatter keys; and a second sync right after is quiet (a live
 * mailbox may receive a message in between, so up to `quietTolerance` writes
 * pass).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertCorpusInvariants } from './harness.js';

/** Frontmatter keys a record of each family should carry. */
export const EXPECTED_KEYS: Array<[RegExp, string[]]> = [
  [/^mail-/, ['subject', 'from', 'date', 'message_id']],
  [/^calendar-/, ['title', 'date']],
  [/^files-/, ['title', 'path', 'file_id']],
  [/^rss-feed$/, ['title', 'url']],
  [/^youtube-/, ['title', 'url', 'date']],
  [/^(x|bluesky|instagram|linkedin)-/, ['url']],
];

/** A request to one project's API (`path` is relative to `/api/projects/:id`). */
export type ProjectApi = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export interface SyncResult {
  written: number;
  quarantined: number;
  skipped: number;
  pruned: number;
  errors: number;
  error?: string;
  rateLimited?: boolean;
}

export interface AcceptanceBinding {
  id: string;
  type: string;
  completeness?: string;
  corpusDir?: string;
}

export interface AcceptanceEntry {
  id: string;
  type: string;
  completeness?: string;
  passes?: SyncResult[];
  records?: number;
  missingKeys?: Record<string, number>;
  /** The first records' paths and frontmatter, only when asked for. */
  sample?: { path: string; frontmatter: Record<string, string> }[];
  quietPass?: SyncResult;
  error?: string;
}

/** Sync one binding and check what it wrote. Never throws; failures are listed. */
export async function checkBinding(
  api: ProjectApi,
  artifactsDir: string,
  binding: AcceptanceBinding,
  opts: { quietTolerance: number; sample?: boolean },
): Promise<{ entry: AcceptanceEntry; failures: string[] }> {
  const entry: AcceptanceEntry = {
    id: binding.id,
    type: binding.type,
    ...(binding.completeness ? { completeness: binding.completeness } : {}),
  };
  const failures: string[] = [];
  const sync = async () =>
    (
      await api<{ result: SyncResult }>(
        'POST',
        `/connectors/${encodeURIComponent(binding.id)}/sync`,
      )
    ).result;
  try {
    const passes: SyncResult[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await sync();
      passes.push(r);
      if (r.error) throw new Error(`sync failed: ${r.error}`);
      if (r.rateLimited) break;
      if (r.written === 0 && i > 0) break;
    }
    entry.passes = passes;
    const corpusDir = binding.corpusDir;
    if (!corpusDir) throw new Error('binding has no corpusDir after syncing');
    // A live project holds every connection's corpus under `data/`, so files
    // there are not this binding's strays.
    const records = await assertCorpusInvariants(artifactsDir, corpusDir, {
      sharedArtifacts: true,
    });
    entry.records = records.length;
    const keys = EXPECTED_KEYS.find(([re]) => re.test(binding.type))?.[1] ?? [];
    const missing = new Map<string, number>();
    for (const r of records) {
      for (const k of keys) if (!r.frontmatter[k]) missing.set(k, (missing.get(k) ?? 0) + 1);
    }
    entry.missingKeys = Object.fromEntries(missing);
    if (records.length > 0 && missing.size > 0) {
      failures.push(`${binding.id}: records missing ${[...missing.keys()].join(', ')}`);
    }
    if (opts.sample) {
      entry.sample = records.slice(0, 3).map((r) => ({ path: r.path, frontmatter: r.frontmatter }));
    }
    const meta = JSON.parse(await readFile(join(artifactsDir, corpusDir, '_meta.json'), 'utf8'));
    if (meta.binding !== binding.id) {
      failures.push(`${binding.id}: _meta.json names ${meta.binding}`);
    }
    const last = passes[passes.length - 1]!;
    if (!last.rateLimited) {
      const quiet = await sync();
      entry.quietPass = quiet;
      if (quiet.error) failures.push(`${binding.id}: resume pass failed: ${quiet.error}`);
      else if (quiet.written > opts.quietTolerance) {
        failures.push(
          `${binding.id}: resume pass rewrote ${quiet.written} records (cursor not resuming?)`,
        );
      }
    }
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
    failures.push(`${binding.id}: ${entry.error}`);
  }
  return { entry, failures };
}

/** Whether a failure is a sign-in the provider no longer accepts. */
export function needsRelink(failure: string): boolean {
  return /Re-link the account/i.test(failure);
}
