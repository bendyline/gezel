import type { KeyValueStorage } from './auth.js';

/**
 * Per-document choices (project, gezel, whether edits are allowed), kept in
 * this origin's localStorage keyed by the document's path — never in the
 * document itself, where they would travel with every copy the user shares.
 */

export interface DocChoices {
  projectId?: string;
  gezelId?: string;
  edits?: boolean;
}

const PREFIX = 'gezel:office:doc:';

function key(path: string): string {
  return `${PREFIX}${path.toLowerCase()}`;
}

export function readDocChoices(storage: KeyValueStorage, path: string | null): DocChoices {
  if (!path) return {};
  try {
    const raw = storage.getItem(key(path));
    return raw ? (JSON.parse(raw) as DocChoices) : {};
  } catch {
    return {};
  }
}

export function writeDocChoices(
  storage: KeyValueStorage,
  path: string | null,
  patch: DocChoices,
): void {
  if (!path) return;
  try {
    storage.setItem(key(path), JSON.stringify({ ...readDocChoices(storage, path), ...patch }));
  } catch {
    /* storage disabled */
  }
}
