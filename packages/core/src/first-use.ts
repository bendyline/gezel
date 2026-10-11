/**
 * A new install's first stretch, measured from `config.firstUseAt`.
 *
 * Only a home that was empty at its first boot carries the stamp. An install
 * without it is established: it predates the stamp, or it was seeded with
 * gezels before it ever booted, and none of these grace periods apply to it.
 */

/**
 * Background indexing waits this long after first use, and until a chat
 * model can answer, whichever is later. The first minutes belong to meeting
 * the Meester; a title bar reporting "scanning Default" during them reads as
 * the app talking about itself.
 */
export const FIRST_USE_INDEXING_GRACE_MS = 30 * 60_000;

/**
 * A night that produced nothing is not reported until the install is this
 * old. On day one, "your crew couldn't work last night" describes a night
 * before the crew existed.
 */
export const QUIET_NIGHT_GRACE_MS = 3 * 24 * 60 * 60_000;

/** How long this home has been in use, or null for an established install. */
export function firstUseAgeMs(firstUseAt: string | undefined, nowMs: number): number | null {
  if (!firstUseAt) return null;
  const startedMs = Date.parse(firstUseAt);
  if (!Number.isFinite(startedMs)) return null;
  return Math.max(0, nowMs - startedMs);
}

/** Whether this home is still within `graceMs` of its first use. */
export function isWithinFirstUse(
  firstUseAt: string | undefined,
  nowMs: number,
  graceMs: number,
): boolean {
  const age = firstUseAgeMs(firstUseAt, nowMs);
  return age !== null && age < graceMs;
}

/** Milliseconds left in the grace period; zero once it has passed or never applied. */
export function firstUseGraceRemainingMs(
  firstUseAt: string | undefined,
  nowMs: number,
  graceMs: number,
): number {
  const age = firstUseAgeMs(firstUseAt, nowMs);
  return age === null ? 0 : Math.max(0, graceMs - age);
}
