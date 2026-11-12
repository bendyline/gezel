import { QueryClient, notifyManager } from '@tanstack/react-query';

// Observers hear about a new answer in a microtask rather than the default
// zero-delay timeout: React batches the updates either way, and the answer is
// on screen one task sooner. It also keeps tests with fake timers honest.
notifyManager.setScheduler(queueMicrotask);

/**
 * The renderer's one cache of server state. Every read the UI keeps in memory
 * lives here, whether a hook (`useApiRead`) or an older call site
 * (`api.getConfig()`, patched by `installApiReads`) asked for it.
 *
 * - `networkMode: 'always'`: the daemon is on loopback; the browser's idea of
 *   being offline says nothing about whether it answers.
 * - `retry: false`: the client already retries transient transport failures
 *   on reads (`withReadTransportRetry`); a second layer would multiply them.
 * - `refetchOnWindowFocus: false`: polls and the event stream keep live data
 *   current; refetching every mounted read on each alt-tab would be a burst
 *   of requests for nothing.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'always',
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      gcTime: 5 * 60_000,
    },
    mutations: { networkMode: 'always', retry: false },
  },
});
