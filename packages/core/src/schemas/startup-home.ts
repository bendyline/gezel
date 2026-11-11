import { z } from 'zod';
import { PoppetjeSchema } from '../poppetje/schema.js';

/**
 * Where the navigation rail sits until the person chooses: the left, under
 * the brand and the back and forward keys. Navigation then reads in one
 * direction (the rail, an area's own list, the content), and the right edge
 * is left for what a click opens. It was the right until 2026-11-11; with the
 * rail there, Settings and Help had navigation on both edges of the window.
 * Someone who picked a side keeps it: the picker writes the choice by name.
 * `ui/public/theme-init.js` repeats this literal, because it runs before
 * any bundle.
 */
export const DEFAULT_SIDEBAR_SIDE: 'left' | 'right' = 'left';

/** A bounded, disposable reading copy. Never carries credentials or live actions. */
export const StartupHomeSnapshotSchema = z.object({
  version: z.literal(1),
  savedAt: z.string(),
  meester: z
    .object({
      id: z.string().max(200),
      name: z.string().max(200),
      poppetje: PoppetjeSchema.optional(),
    })
    .nullable(),
  showPoppetjes: z.boolean().optional(),
  /**
   * Nobody has used this home yet (no session, no project of their own), so
   * Home opens on the Meester's welcome; the start screen draws that shape.
   */
  welcome: z.boolean().optional(),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  sidebar: z.enum(['left', 'right']).default(DEFAULT_SIDEBAR_SIDE),
  status: z
    .object({
      headline: z.string().max(200),
      content: z.string().max(16_000),
      at: z.string(),
    })
    .nullable()
    .default(null),
  lastMessage: z
    .object({ content: z.string().max(8_000), at: z.string() })
    .nullable()
    .default(null),
  night: z
    .object({
      windowEnd: z.string(),
      completed: z.number().int().nonnegative(),
      reportCount: z.number().int().nonnegative().optional(),
      proposals: z.number().int().nonnegative().optional(),
      actions: z.number().int().nonnegative().optional(),
      reports: z
        .array(
          z.object({
            title: z.string().max(300),
            project: z.string().max(200),
            content: z.string().max(16_000),
          }),
        )
        .max(3),
    })
    .nullable()
    .default(null),
});
export type StartupHomeSnapshot = z.infer<typeof StartupHomeSnapshotSchema>;

export const StartupHomeViewSchema = z.object({
  tab: z.enum(['greeting', 'night', 'tour', 'chat']).default('greeting'),
  article: z.number().int().min(0).max(20).default(0),
  scroll: z.number().finite().min(0).max(1_000_000).default(0),
  draft: z.string().max(32_000).default(''),
  focused: z.boolean().default(false),
  selectionStart: z.number().int().min(0).max(32_000).default(0),
  selectionEnd: z.number().int().min(0).max(32_000).default(0),
});
export type StartupHomeView = z.infer<typeof StartupHomeViewSchema>;
