/**
 * One age past which a chat thread stops counting as "the conversation
 * the user is still in".
 *
 * Three surfaces ask that question and must agree, or the app
 * contradicts itself: opening a project resumes the last thread
 * ({@link ../components/ProjectChat.tsx}), the timeline fades bubbles
 * from threads nobody is in any more, and the timeline pins the
 * composer's thread to the bottom ({@link ./active-thread-pin.ts}).
 * A thread that is fresh enough to resume is fresh enough to pin.
 */
export const FRESH_THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Is `iso` within {@link FRESH_THREAD_MAX_AGE_MS} of `nowMs`? */
export function isFreshThreadAt(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && nowMs - at <= FRESH_THREAD_MAX_AGE_MS;
}
