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
