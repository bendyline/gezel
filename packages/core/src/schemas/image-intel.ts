import { z } from 'zod';

/**
 * Image-intel wire shapes: search by meaning (on-device multimodal
 * embeddings) fused with filename/caption search, visual nearest neighbours,
 * and a folder-level summary over a project's indexed images. Search also
 * reaches audio and video, by window, when asked.
 */

export const MediaSearchKindSchema = z.enum(['image', 'audio', 'video']);
export type MediaSearchKind = z.infer<typeof MediaSearchKindSchema>;

export const SearchImagesRequestSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(100).optional(),
  /** Which media to search; default images only. */
  kinds: z.array(MediaSearchKindSchema).min(1).optional(),
});
export type SearchImagesRequest = z.infer<typeof SearchImagesRequestSchema>;

export const SearchImagesResponseSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      format: z.string().optional(),
      caption: z.string().optional(),
      score: z.number(),
      /** Absent means image (results before audio/video search). */
      kind: MediaSearchKindSchema.optional(),
      /** The matching window of an audio or video file. */
      startMs: z.number().int().nonnegative().optional(),
      endMs: z.number().int().nonnegative().optional(),
    }),
  ),
  /** vector/hybrid = matched by meaning (with or without filename/caption hits). */
  engine: z.enum(['fts', 'vector', 'hybrid', 'unavailable']),
  truncated: z.boolean(),
});
export type SearchImagesResponse = z.infer<typeof SearchImagesResponseSchema>;

export const FindSimilarImagesRequestSchema = z.object({
  path: z.string().min(1),
  maxResults: z.number().int().positive().max(100).optional(),
});
export type FindSimilarImagesRequest = z.infer<typeof FindSimilarImagesRequestSchema>;

export const FindSimilarImagesResponseSchema = z.object({
  results: z.array(z.object({ path: z.string(), score: z.number() })),
  /** vector = visual neighbours; unavailable = no image embeddings yet. */
  engine: z.enum(['vector', 'unavailable']),
  truncated: z.boolean(),
});
export type FindSimilarImagesResponse = z.infer<typeof FindSimilarImagesResponseSchema>;

export const DescribeFolderRequestSchema = z.object({
  path: z.string().optional(),
});
export type DescribeFolderRequest = z.infer<typeof DescribeFolderRequestSchema>;

export const DescribeFolderResponseSchema = z.object({
  path: z.string(),
  imageCount: z.number().int().nonnegative(),
  formats: z.array(z.object({ format: z.string(), count: z.number().int() })),
  dimensions: z
    .object({
      minWidth: z.number().int(),
      maxWidth: z.number().int(),
      minHeight: z.number().int(),
      maxHeight: z.number().int(),
    })
    .nullable(),
  samples: z.array(z.string()),
  captioned: z.number().int().nonnegative(),
});
export type DescribeFolderResponse = z.infer<typeof DescribeFolderResponseSchema>;

/**
 * One photo as the index knows it, for `list_photos`, `photo_groups` and the
 * On this day card. `location` is present only for the person's own app and
 * on-device sessions: a photo's coordinates say where someone lives.
 */
export const PhotoRecordSchema = z.object({
  path: z.string(),
  /** Camera local time, `YYYY-MM-DDTHH:MM:SS`; absent when the photo has no capture date. */
  takenAt: z.string().optional(),
  camera: z.string().optional(),
  lens: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  format: z.string().optional(),
  screenshot: z.boolean().optional(),
  /** Stored only in the cloud: listed, never read. */
  cloudOnly: z.boolean().optional(),
  /** What the photo shows, once the crew has described it. */
  caption: z.string().optional(),
  location: z.object({ lat: z.number(), lon: z.number() }).optional(),
});
export type PhotoRecord = z.infer<typeof PhotoRecordSchema>;

export const ListPhotosRequestSchema = z.object({
  /** Folder to scope to; the whole workspace when absent. */
  path: z.string().optional(),
  /** Taken on or after (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`). */
  from: z.string().optional(),
  /** Taken on or before, same forms. */
  to: z.string().optional(),
  /** Within `km` (default 5) of a place. Matches only photos that carry a location. */
  near: z
    .object({ lat: z.number(), lon: z.number(), km: z.number().positive().optional() })
    .optional(),
  /** Camera make or model, any part, any case. */
  camera: z.string().optional(),
  /** true: only screenshots; false: leave screenshots out. */
  screenshots: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type ListPhotosRequest = z.infer<typeof ListPhotosRequestSchema>;

export const ListPhotosResponseSchema = z.object({
  photos: z.array(PhotoRecordSchema),
  /** Matches before `limit`. */
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** Locations exist but were left out for this session. */
  locationWithheld: z.boolean().optional(),
});
export type ListPhotosResponse = z.infer<typeof ListPhotosResponseSchema>;

export const PhotoGroupKindSchema = z.enum(['event', 'duplicate', 'similar']);
export type PhotoGroupKind = z.infer<typeof PhotoGroupKindSchema>;

export const PhotoGroupsRequestSchema = z.object({
  /** event: taken together; duplicate: byte-identical; similar: look alike. */
  by: PhotoGroupKindSchema,
  path: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type PhotoGroupsRequest = z.infer<typeof PhotoGroupsRequestSchema>;

export const PhotoGroupSchema = z.object({
  /** For events, the first and last capture time. */
  from: z.string().optional(),
  to: z.string().optional(),
  count: z.number().int().positive(),
  /** Every path for duplicates and lookalikes; a sample for events. */
  paths: z.array(z.string()),
  /** Duplicates: bytes the extra copies take. */
  bytes: z.number().nonnegative().optional(),
  /** Events: where, when this session may see locations. */
  location: z.object({ lat: z.number(), lon: z.number() }).optional(),
});
export type PhotoGroup = z.infer<typeof PhotoGroupSchema>;

export const PhotoGroupsResponseSchema = z.object({
  by: PhotoGroupKindSchema,
  groups: z.array(PhotoGroupSchema),
  truncated: z.boolean(),
  /** similar: unavailable until photos have image embeddings. */
  engine: z.enum(['metadata', 'vector', 'unavailable']),
  locationWithheld: z.boolean().optional(),
});
export type PhotoGroupsResponse = z.infer<typeof PhotoGroupsResponseSchema>;

/** Photos taken on this calendar day in earlier years, newest year first. */
export const OnThisDayResponseSchema = z.object({
  /** `MM-DD`. */
  day: z.string(),
  years: z.array(
    z.object({ year: z.number().int(), count: z.number().int(), paths: z.array(z.string()) }),
  ),
});
export type OnThisDayResponse = z.infer<typeof OnThisDayResponseSchema>;

/** Where album proposals live in a project's artifacts drawer. */
export const PHOTO_ALBUMS_ARTIFACT_DIR = 'albums';

/**
 * Frontmatter key on an album document: compact JSON mapping each stored copy
 * (as the document links it, `<stem>_files/<name>.jpg`) to the workspace photo
 * it was made from. Squisq passes unknown frontmatter through untouched.
 */
export const PHOTO_ALBUM_ORIGINALS_KEY = 'gezel-photo-originals';
/** Frontmatter keys for the outing's first and last capture time. */
export const PHOTO_ALBUM_FROM_KEY = 'album-from';
export const PHOTO_ALBUM_TO_KEY = 'album-to';

export const PhotoAlbumPhotoSchema = z.object({
  /** As the document links it: a stored copy, or a workspace path not yet copied. */
  src: z.string(),
  /** The workspace photo it shows, when known. */
  original: z.string().optional(),
  caption: z.string().optional(),
});
export type PhotoAlbumPhoto = z.infer<typeof PhotoAlbumPhotoSchema>;

/**
 * An album proposal, read from its Squisq slideshow document
 * (`albums/<date>-<slug>.md`): the person plays it, edits it, and exports it
 * to video in the document editor. The photos are resized copies in the
 * album's own `_files` folder; the originals are never moved.
 */
export const PhotoAlbumSchema = z.object({
  /** Artifact path, `albums/<name>.md`. */
  path: z.string(),
  title: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** The paragraph under the title, which Squisq shows on the cover. */
  story: z.string().optional(),
  photos: z.array(PhotoAlbumPhotoSchema),
});
export type PhotoAlbum = z.infer<typeof PhotoAlbumSchema>;

export const PhotoAlbumSummarySchema = z.object({
  /** Artifact path, `albums/<name>.md`. */
  path: z.string(),
  title: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** Workspace path of the cover photo's original, for a thumbnail. */
  cover: z.string().optional(),
  count: z.number().int().nonnegative(),
  /** Photos still linked to the workspace rather than stored with the album. */
  pending: z.number().int().nonnegative().optional(),
  updatedAt: z.string().optional(),
});
export type PhotoAlbumSummary = z.infer<typeof PhotoAlbumSummarySchema>;
