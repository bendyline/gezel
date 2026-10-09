/**
 * `GET /api/media-search` — the media-search model's state for the Settings
 * card: whether searching photos, video and audio by meaning is on, which
 * parts of the model (text, vision, audio) are on disk, a download in
 * progress, and whether ffmpeg is there for video and audio.
 */
export const MEDIA_SEARCH_STATUSES = [
  'off',
  'not-installed',
  'blocked-network',
  'downloading',
  'ready',
  'error',
] as const;
export type MediaSearchStatus = (typeof MEDIA_SEARCH_STATUSES)[number];

export interface MediaSearchStatusResponse {
  enabled: boolean;
  status: MediaSearchStatus;
  /** The knowledge profile the index embeds with (one space with catalogs). */
  profileId: string;
  /** Model parts on disk: text always precedes vision and audio. */
  installedParts: Array<'text' | 'vision' | 'audio'>;
  imageTokenBudget: number;
  /** Bytes the images download needs, and the audio encoder on top. */
  approxBytes: { images: number; audio: number };
  progress?: { bytesDone: number; bytesTotal: number };
  error?: string;
  /** Video and audio need a system ffmpeg; null when none was found. */
  ffmpeg: { path: string; version: string } | null;
}
