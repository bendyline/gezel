import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../fs/atomic.js';

export interface PendingPull {
  name: string;
  /** ISO timestamp of when this pull was first initiated. */
  startedAt: string;
}

interface StoreShape {
  pulls: PendingPull[];
}

/**
 * Tracks "user asked for this model; pull has started but hasn't finished
 * yet." Persisted to `~/.gezel/pending-pulls.json` so that if the user
 * closes Gezel mid-download, the next launch can re-initiate the pull
 * (Ollama resumes from the last completed blob, so the user gets progress
 * immediately without clicking Install again).
 *
 * Entries are added when `POST /api/ollama/pull` starts streaming, and
 * removed when Ollama emits a `success` status or the UI explicitly
 * cancels. Crashes or abrupt app closes leave entries in place — that's
 * the whole point.
 */

function filePath(home: string): string {
  return join(home, 'pending-pulls.json');
}

async function readStore(home: string): Promise<StoreShape> {
  const path = filePath(home);
  if (!existsSync(path)) return { pulls: [] };
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { pulls?: unknown }).pulls)
    ) {
      const pulls = (parsed as { pulls: unknown[] }).pulls.filter(
        (p): p is PendingPull =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as PendingPull).name === 'string' &&
          typeof (p as PendingPull).startedAt === 'string',
      );
      return { pulls };
    }
  } catch {
    /* treat corrupt JSON as empty */
  }
  return { pulls: [] };
}

async function writeStore(home: string, store: StoreShape): Promise<void> {
  // Was a local tmp+rename with `${path}.tmp`; consolidated onto the
  // shared `writeFileAtomic` so the tmp suffix carries pid + UUID and
  // doesn't collide between two concurrent writers (rare here, but
  // also one less drift point to keep in sync with store.ts).
  await writeFileAtomic(filePath(home), JSON.stringify(store, null, 2));
}

export async function listPendingPulls(home: string): Promise<PendingPull[]> {
  const store = await readStore(home);
  return store.pulls;
}

export async function addPendingPull(home: string, name: string): Promise<void> {
  const store = await readStore(home);
  // Idempotent — if the tag is already pending, don't duplicate or reset
  // the timestamp (we want to know how long this particular attempt has
  // been running, not when we most recently retried it).
  if (store.pulls.some((p) => p.name === name)) return;
  store.pulls.push({ name, startedAt: new Date().toISOString() });
  await writeStore(home, store);
}

export async function removePendingPull(home: string, name: string): Promise<void> {
  const store = await readStore(home);
  const next = store.pulls.filter((p) => p.name !== name);
  if (next.length === store.pulls.length) return;
  await writeStore(home, { pulls: next });
}
