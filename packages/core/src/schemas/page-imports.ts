import { z } from 'zod';

export const PAGE_IMPORT_MAX_BYTES = 256 * 1024 * 1024;
/** Portable child names: no paths, Windows devices, alternate streams or hidden files. */
export const PageImportNameSchema = z
  .string()
  .min(1)
  .max(180)
  .regex(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in portable filenames.
    /^(?!\.)(?!.*[. ]$)(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$))[^<>:"/\\|?*\x00-\x1f]+$/i,
  );
export const PageImportTargetSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  source: z.literal('workspace'),
  path: z.string().min(1).max(500),
  /** Extensions, including the dot. Omitted means any file type. */
  accept: z
    .array(z.string().regex(/^\.[a-z0-9]+$/))
    .min(1)
    .optional(),
  maxFileBytes: z.number().int().positive().max(PAGE_IMPORT_MAX_BYTES).optional(),
});
export type PageImportTarget = z.infer<typeof PageImportTargetSchema>;
export type PageImportAvailability = PageImportTarget & { writable: boolean; reason?: string };
export const PageImportRequestSchema = z.object({
  target: z.string().min(1).max(64),
  name: PageImportNameSchema,
});
export type PageImportedFile = {
  source: 'workspace';
  path: string;
  name: string;
  size: number;
  mtime: number;
};
