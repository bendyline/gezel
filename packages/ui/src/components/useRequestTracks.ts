import type { RequestTrack } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useActivity } from './activity-context.js';

/**
 * The requests written in `sessionIds`, by key (`RequestTrack.key`). Fetched
 * when the threads change or a request starts or finishes; the Activity
 * snapshot, which already polls, keeps the live ones current in between.
 */
export function useRequestTracks(sessionIds: readonly string[]): {
  tracks: ReadonlyMap<string, RequestTrack>;
  /** The first answer (or a refusal from a daemon without requests) has arrived. */
  loaded: boolean;
} {
  const activity = useActivity();
  const sessions = useMemo(() => [...new Set(sessionIds)].sort().join(','), [sessionIds]);
  const live = activity?.snapshot?.requests;
  // A request joining or leaving the live set is the moment a fetch has
  // something new to say (it started, or it is Ready now).
  const liveKeys = (live ?? [])
    .map((track) => track.key)
    .sort()
    .join('|');
  const [fetched, setFetched] = useState<ReadonlyMap<string, RequestTrack>>(new Map());
  // The session set the last answer was for: a thread joining the view must
  // not read as answered until its requests have been fetched too.
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: liveKeys deliberately re-runs the fetch when a request starts or finishes.
  useEffect(() => {
    if (!sessions) {
      setFetched(new Map());
      return;
    }
    let cancelled = false;
    api
      .listRequests({ sessions: sessions.split(',') })
      .then((res) => {
        if (!cancelled) setFetched(new Map(res.requests.map((track) => [track.key, track])));
      })
      // A daemon without requests shows the thread as it always did.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAnsweredFor(sessions);
      });
    return () => {
      cancelled = true;
    };
  }, [sessions, liveKeys]);
  const tracks = useMemo(() => {
    if (!live?.length) return fetched;
    const wanted = new Set(sessions.split(','));
    const merged = new Map(fetched);
    for (const track of live) if (wanted.has(track.sessionId)) merged.set(track.key, track);
    return merged;
  }, [fetched, live, sessions]);
  return { tracks, loaded: sessions === '' || answeredFor === sessions };
}
