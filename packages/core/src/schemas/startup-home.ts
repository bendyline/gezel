import { z } from 'zod';

/** A bounded, disposable reading copy. Never carries credentials or live actions. */
export const StartupHomeSnapshotSchema = z.object({
  version: z.literal(1),
  savedAt: z.string(),
  meester: z.object({ id: z.string().max(200), name: z.string().max(200) }).nullable(),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  sidebar: z.enum(['left', 'right']).default('right'),
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
