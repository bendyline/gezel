/**
 * How a media search hit reads to a person: what it is and, for video and
 * sound, which moment matched. Shared by every surface that lists results so
 * a moment reads the same in the titlebar, the Knowledge browser and chat.
 */

export interface MediaSpan {
  modality: 'image' | 'video' | 'audio';
  startMs?: number;
  endMs?: number;
}

/** `95_500` → `1:35`; `3_725_000` → `1:02:05`. */
export function formatMediaClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** `Photo`, `Video · 1:30–2:00`, `Sound · 0:00–0:30`. */
export function mediaSpanLabel(media: MediaSpan): string {
  const kind =
    media.modality === 'image' ? 'Photo' : media.modality === 'video' ? 'Video' : 'Sound';
  if (media.startMs === undefined) return kind;
  const end = media.endMs !== undefined ? `–${formatMediaClock(media.endMs)}` : '';
  return `${kind} · ${formatMediaClock(media.startMs)}${end}`;
}
