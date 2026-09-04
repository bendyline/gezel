import { type RunRecording, parseRunRecording } from '@bendyline/gezel';

export interface LoadedRecording {
  recording: RunRecording;
  /** Human-readable degradations (unknown scene kinds dropped, etc.). */
  warnings: string[];
}

/**
 * Defensive loader for `transcript.json` payloads: tolerant-mode parse
 * (unknown keys stripped, future schemaVersion clamped, unknown scene
 * KINDS dropped with a warning) so recorder evolution never breaks
 * playback. Throws only on structural invalidity — a recording that
 * cannot be a timeline at all.
 */
export function loadRecording(raw: unknown): LoadedRecording {
  const parsed = parseRunRecording(raw, { mode: 'tolerant' });
  if (!parsed.ok) {
    throw new Error(`invalid run recording: ${parsed.errors.slice(0, 5).join('; ')}`);
  }
  const warnings: string[] = [];
  if (parsed.droppedUnknownScenes > 0) {
    warnings.push(
      `${parsed.droppedUnknownScenes} scene(s) of unknown kind were dropped (recording written by a newer producer)`,
    );
  }
  return { recording: parsed.recording, warnings };
}
