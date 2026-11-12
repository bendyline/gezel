import type { ConfigResponse } from '@bendyline/gezel-client';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { loadRead } from './api-reads.js';
import { watchProductChangeEvents } from './invalidation.js';
import { queryClient } from './query-client.js';
import { READS, type ReadArgs, type ReadName, type ReadValue, readKey } from './reads.js';

// Whatever reads through the cache hears product changes, including a test
// that replaced the api module (which normally starts the listener).
watchProductChangeEvents();

export interface ApiReadOptions<Value, Selected> {
  /** Derive what the component shows. It re-renders only when this result changes. */
  select?: (value: Value) => Selected;
  /**
   * Ask again on this interval while mounted and the window is shown. One
   * owner per poll: mount the read where the value is shown, not in a parent.
   */
  pollMs?: number;
}

export interface ApiReadResult<Selected> {
  /** The answer, from memory when known (even stale), else undefined until it arrives. */
  data: Selected | undefined;
  /** No answer yet, from memory or the daemon. */
  pending: boolean;
  /** The last read failed. A kept answer stays in `data`. */
  error: unknown;
  /** Ask again now. */
  refresh: () => void;
}

const DISABLED = Symbol.for('gezel.data.disabled');

/**
 * Read server state through the renderer's cache. The first frame paints the
 * kept answer when there is one; a stale answer is read again in the
 * background. Pass `null` as `args` to wait (for example, until an id is known).
 */
export function useApiRead<K extends ReadName, Selected = ReadValue<K>>(
  name: K,
  args: ReadArgs<K> | null,
  options: ApiReadOptions<ReadValue<K>, Selected> = {},
): ApiReadResult<Selected> {
  const key = args ? readKey(name, args) : ['api', name, DISABLED];
  const query = useQuery(
    {
      queryKey: key,
      queryFn: () => loadRead(api, name, args ?? [], key, { backgroundWhenPainted: true }),
      staleTime: READS[name].staleMs,
      enabled: args !== null,
      select: options.select,
      refetchInterval: options.pollMs ?? false,
      refetchIntervalInBackground: false,
    },
    queryClient,
  );
  return {
    data: query.data,
    pending: query.isPending,
    error: query.error,
    refresh: () => void query.refetch(),
  };
}

/** One value from config, kept current as config changes anywhere in the app. */
export function useConfig<Selected>(
  select: (config: ConfigResponse) => Selected,
): Selected | undefined {
  return useApiRead('getConfig', [], { select }).data;
}
