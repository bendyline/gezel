import type { GezelClient } from '@bendyline/gezel-client';
import { type Query, type QueryKey, isCancelledError } from '@tanstack/react-query';
import { asBackground } from '../nav-timing.js';
import { queryClient } from './query-client.js';
import {
  READS,
  READ_NAMES,
  type ReadArgs,
  type ReadName,
  type ReadScope,
  type ReadValue,
  readKey,
  readNameOf,
} from './reads.js';

/** How long past freshness a kept answer may still paint a view that has no observer. */
const SNAPSHOT_GRACE_MS = 30_000;

const ORIGINAL = Symbol.for('gezel.data.original-read');

type AnyRead = ((...args: unknown[]) => Promise<unknown>) & { [ORIGINAL]?: AnyRead };

/**
 * Call the client's own method for a read, never the cached wrapper:
 * `installApiReads` replaces the method with one that asks the cache, and the
 * cache asking itself would wait on its own answer. Tests that replace `api`
 * with plain mocks have no wrapper, so the mock is called directly.
 */
export function callRead<K extends ReadName>(
  client: GezelClient,
  name: K,
  args: readonly unknown[],
): Promise<ReadValue<K>> {
  const method = client[name] as unknown as AnyRead | undefined;
  if (typeof method !== 'function') {
    return Promise.reject(new TypeError(`api.${name} is not available`));
  }
  return (method[ORIGINAL] ?? method).apply(client, [...args]) as Promise<ReadValue<K>>;
}

/**
 * Load a read for the cache. Revalidating an answer that is already on screen
 * is background work: navigation timing should not wait for it, because the
 * view painted from memory.
 */
export function loadRead<K extends ReadName>(
  client: GezelClient,
  name: K,
  args: readonly unknown[],
  key: QueryKey,
  options: { backgroundWhenPainted: boolean },
): Promise<ReadValue<K>> {
  const painted = (queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) > 0;
  const run = () => callRead(client, name, args);
  return options.backgroundWhenPainted && painted ? asBackground(run) : run();
}

/** Ask the cache the way an older call site does: the answer, read again only when stale. */
async function fetchRead<K extends ReadName>(
  client: GezelClient,
  name: K,
  args: readonly unknown[],
): Promise<ReadValue<K>> {
  const key = readKey(name, args);
  const options = {
    queryKey: key,
    queryFn: () => loadRead(client, name, args, key, { backgroundWhenPainted: false }),
    staleTime: READS[name].staleMs,
  };
  // A write cancels the reads it may have outdated. Their callers still want an
  // answer, so they ask again and join the read that replaced them.
  for (let attempt = 0; ; attempt++) {
    try {
      return (await queryClient.fetchQuery(options)) as ReadValue<K>;
    } catch (error) {
      if (!isCancelledError(error) || attempt >= 3) throw error;
    }
  }
}

/**
 * Route the client's shared reads through the cache. Older call sites keep
 * calling `api.getConfig()` and get their own copy (some sort or edit the
 * response in place); hooks read the cached object itself, which keeps its
 * identity while nothing in it changes.
 */
export function installApiReads(client: GezelClient): void {
  for (const name of READ_NAMES) {
    const current = client[name] as unknown as AnyRead;
    if (current[ORIGINAL]) continue;
    const original = current.bind(client) as AnyRead;
    const cached: AnyRead = (...args: unknown[]) =>
      fetchRead(client, name, args).then((value) => structuredClone(value));
    cached[ORIGINAL] = original;
    Object.assign(client, { [name]: cached });
  }
}

/**
 * A recently known answer, to paint a view in its first frame while its
 * ordinary read revalidates it. A stale answer still paints: after a write
 * the view shows what it showed a moment ago instead of an empty pane.
 */
export function peekRead<K extends ReadName>(
  name: K,
  ...args: ReadArgs<K>
): ReadValue<K> | undefined {
  const query = queryClient.getQueryCache().find({ queryKey: readKey(name, args), exact: true });
  const state = query?.state;
  if (state?.data === undefined) return undefined;
  const watched = (query?.getObserversCount() ?? 0) > 0;
  if (!watched && state.dataUpdatedAt + READS[name].staleMs + SNAPSHOT_GRACE_MS <= Date.now()) {
    return undefined;
  }
  return structuredClone(state.data) as ReadValue<K>;
}

/**
 * Read again now, whether or not the answer is stale. A read already in
 * flight is joined, not restarted. For moments a view knows the answer may
 * have moved without a write it saw (a project switch, a roster change).
 */
export function refreshRead<K extends ReadName>(name: K, args: ReadArgs<K>): void {
  void queryClient
    .refetchQueries({ queryKey: readKey(name, args), exact: true }, { cancelRefetch: false })
    .catch(() => {});
}

/** Put a known answer in the cache, for a write that returns the new state. */
export function setRead<K extends ReadName>(
  name: K,
  args: ReadArgs<K>,
  value: ReadValue<K> | ((previous: ReadValue<K> | undefined) => ReadValue<K> | undefined),
): void {
  queryClient.setQueryData(readKey(name, args), value as never);
}

function inScopes(query: Query, scopes: readonly ReadScope[] | 'all'): boolean {
  const name = readNameOf(query.queryKey);
  if (!name) return false;
  return scopes === 'all' || scopes.includes(READS[name].scope);
}

/**
 * Mark reads stale. A read in flight is cancelled, so an answer begun before a
 * write is never kept as the fresh answer after it; its callers ask again.
 * Kept answers still paint. With `refetch`, reads a mounted view is watching
 * ask again now; the rest ask when something next wants them.
 */
export function markReadsStale(
  scopes: readonly ReadScope[] | 'all',
  options: { refetch: boolean },
): void {
  const predicate = (query: Query) => inScopes(query, scopes);
  for (const query of queryClient.getQueryCache().findAll({ predicate })) {
    if (query.state.fetchStatus !== 'idle') void query.cancel({ silent: true, revert: true });
  }
  void queryClient
    .invalidateQueries({ predicate, refetchType: options.refetch ? 'active' : 'none' })
    .catch(() => {});
}

/** Forget every answer, stale ones included. Tests and a change of daemon use it. */
export function resetReads(): void {
  queryClient.cancelQueries().catch(() => {});
  queryClient.clear();
}
