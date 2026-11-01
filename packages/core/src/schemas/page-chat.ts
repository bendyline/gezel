import { z } from 'zod';

/** Presentation controls, never additional project or model authority. */
export const PageChatOptionsSchema = z
  .object({
    gezelId: z.string().min(1).max(128).optional(),
    gezelRole: z.string().min(1).max(128).optional(),
    lockRecipient: z.boolean().optional(),
    variant: z.enum(['chat', 'composer']).optional(),
    showAddress: z.boolean().optional(),
    showThreads: z.boolean().optional(),
    placeholder: z.string().max(500).optional(),
    attachments: z.boolean().optional(),
    dictation: z.boolean().optional(),
    promptAssist: z.boolean().optional(),
    expand: z.boolean().optional(),
  })
  .strict();
export type PageChatOptions = z.infer<typeof PageChatOptionsSchema>;

export const PageChatRectSchema = z
  .object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
    width: z.number().finite().min(0).max(100_000),
    height: z.number().finite().min(0).max(100_000),
  })
  .strict();

export const PageChatMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      __gezelPage: z.literal(1),
      kind: z.literal('chat-mount'),
      id: z.string().min(1).max(64),
      options: PageChatOptionsSchema,
    })
    .strict(),
  z
    .object({
      __gezelPage: z.literal(1),
      kind: z.literal('chat-update'),
      id: z.string().min(1).max(64),
      options: PageChatOptionsSchema,
    })
    .strict(),
  z
    .object({
      __gezelPage: z.literal(1),
      kind: z.literal('chat-position'),
      id: z.string().min(1).max(64),
      rect: PageChatRectSchema,
    })
    .strict(),
  z
    .object({
      __gezelPage: z.literal(1),
      kind: z.literal('chat-destroy'),
      id: z.string().min(1).max(64),
    })
    .strict(),
]);

export const PageLayoutSchema = z.object({
  fullscreen: z.boolean(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type PageLayout = z.infer<typeof PageLayoutSchema>;
