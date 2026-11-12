import type { GezelClient } from '@bendyline/gezel-client';

/**
 * What a write or a stream event can change. A change to a scope marks every
 * read in it stale; mounted reads ask again, and the rest ask the next time
 * something wants them.
 */
export type ReadScope = 'config' | 'roster' | 'projects' | 'live' | 'home' | 'engines';

interface ReadPolicy {
  /** How long an answer is fresh. A stale answer still paints while it is read again. */
  staleMs: number;
  scope: ReadScope;
}

/**
 * Every server read the renderer keeps in memory. A read not listed here is
 * fetched by whoever needs it and never shared; add it here once a second
 * surface wants the same answer.
 */
export const READS = {
  getConfig: { staleMs: 5_000, scope: 'config' },
  listGezels: { staleMs: 5_000, scope: 'roster' },
  listProjects: { staleMs: 5_000, scope: 'projects' },
  getProject: { staleMs: 5_000, scope: 'projects' },
  listProjectAttachments: { staleMs: 5_000, scope: 'live' },
  listChatSessions: { staleMs: 1_000, scope: 'live' },
  getQueueStatus: { staleMs: 1_000, scope: 'live' },
  listInflightTurns: { staleMs: 1_000, scope: 'live' },
  getUsage: { staleMs: 5_000, scope: 'live' },
  getSystemHomeInfo: { staleMs: 5_000, scope: 'home' },
} as const satisfies Record<string, ReadPolicy>;

export type ReadName = keyof typeof READS;
export type ReadArgs<K extends ReadName> = Parameters<GezelClient[K]>;
export type ReadValue<K extends ReadName> = Awaited<ReturnType<GezelClient[K]>>;

export const READ_NAMES = Object.keys(READS) as ReadName[];

/** The cache key for one read. Trailing `undefined` arguments are dropped, so `f()` and `f(undefined)` share. */
export function readKey<K extends ReadName>(name: K, args: readonly unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end--;
  return ['api', name, ...args.slice(0, end)];
}

/** The read a cache key belongs to, or null for keys this table does not own. */
export function readNameOf(key: readonly unknown[]): ReadName | null {
  if (key[0] !== 'api' || typeof key[1] !== 'string') return null;
  return key[1] in READS ? (key[1] as ReadName) : null;
}
