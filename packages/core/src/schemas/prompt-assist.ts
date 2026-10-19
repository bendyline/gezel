import { z } from 'zod';

/** What the composer's sparkle menu can do to a draft before it is sent. */
export const PromptAssistActionSchema = z.enum([
  'clarify',
  'shorten',
  'proofread',
  'review',
  'shape-image',
]);
export type PromptAssistAction = z.infer<typeof PromptAssistActionSchema>;

/** Body for `POST /api/projects/:id/prompt-assist`. */
export const PromptAssistRequestSchema = z.object({
  action: PromptAssistActionSchema,
  text: z.string().min(1).max(20_000),
  /** The gezel the message is addressed to: names the recipient, and its model runs the rewrite. */
  gezelId: z.string().optional(),
  /** For `shape-image`: the image model that will draw it, for its prompt guide. */
  imageModel: z.string().optional(),
  /** For `clarify`: suggestions from an earlier `review` to apply. */
  notes: z.array(z.string().min(1)).max(8).optional(),
});
export type PromptAssistRequest = z.infer<typeof PromptAssistRequestSchema>;

export const PromptAssistResponseSchema = z.object({
  /** The rewritten draft, for every action but `review`. */
  text: z.string().optional(),
  /** The rewrite matched the draft: it already read well, and nothing changes. */
  unchanged: z.boolean().optional(),
  /** `review` only. */
  suggestions: z.array(z.string()).optional(),
});
export type PromptAssistResponse = z.infer<typeof PromptAssistResponseSchema>;
