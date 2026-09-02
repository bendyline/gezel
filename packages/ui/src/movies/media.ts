import type { RunRecording, RunRecordingActor } from '@bendyline/gezel';

/**
 * Media the mapped doc references, all as paths RELATIVE TO THE
 * TRANSCRIPT'S DIRECTORY (the recording contract). Consumers resolve
 * them their own way: the eval-viewer via `DocPlayer basePath`, the MP4
 * path via a read-only fs ContentContainer rooted at the recording dir,
 * a standalone HTML export by inlining data-URIs into the player's
 * `images` map.
 */
export interface MovieMediaRef {
  path: string;
  kind: 'poppetje' | 'screenshot';
  actorId?: string;
}

/** Where the capture/pipeline pre-renders an actor's figure, when it does. */
export function poppetjeMediaPath(
  actorId: string,
  variant: 'headshot' | 'full' = 'headshot',
): string {
  return `media/poppetje/${actorId}.${variant}.svg`;
}

/**
 * True when the recording (or the caller) can actually serve an actor's
 * pre-rendered poppetje SVG. The poppetje STRUCT always rides in
 * `actors[]`, but rendering it needs React (the UI's renderer), so
 * React-free consumers fall back to an initials avatar unless the
 * pipeline pre-rendered the SVG next to the transcript.
 */
export function hasPoppetjeMedia(
  actor: RunRecordingActor,
  availableMedia: ReadonlySet<string> | undefined,
): boolean {
  if (!availableMedia) return false;
  return availableMedia.has(poppetjeMediaPath(actor.id));
}

export function collectScreenshotRefs(recording: RunRecording): MovieMediaRef[] {
  const refs: MovieMediaRef[] = [];
  for (const shot of recording.screenshots ?? []) {
    refs.push({ path: shot.file, kind: 'screenshot' });
  }
  return refs;
}
