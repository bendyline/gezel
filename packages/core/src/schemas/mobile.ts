import { z } from 'zod';
import { PoppetjeSchema } from '../poppetje/schema.js';
import { ChatMessageSchema, GezelDetailSchema } from './gezel.js';
import { MobileProviderIdSchema } from './mobile-provider.js';
import { ProjectSchema } from './project.js';
import { ChatSessionSchema } from './session.js';

export const MOBILE_MAX_STATE_CHARS = 4 * 1024 * 1024;
export const MOBILE_MAX_MESSAGE_CHARS = 64_000;
export const MOBILE_MAX_INPUT_CHARS = 16_000;
export const MOBILE_MAX_CONTEXT_CHARS = 24_000;
export const MOBILE_MAX_SESSIONS = 100;
export const MOBILE_MAX_MESSAGES = 400;

const MobileIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const MobileDateSchema = z.string().datetime({ offset: true });

export const MobileGezelSchema = GezelDetailSchema.pick({
  id: true,
  name: true,
  role: true,
  about: true,
})
  .extend({
    id: z.literal('meester'),
    name: z.string().min(1).max(100),
    role: z.literal('Meester'),
    about: z.string().min(1).max(8_000),
    poppetje: PoppetjeSchema,
  })
  .strict();

export const MobileProjectSchema = ProjectSchema.pick({
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
})
  .extend({
    id: z.literal('default'),
    name: z.string().min(1).max(100),
    createdAt: MobileDateSchema,
    updatedAt: MobileDateSchema,
  })
  .strict();

export const MobileMessageSchema = ChatMessageSchema.pick({
  role: true,
  content: true,
  at: true,
})
  .extend({
    id: MobileIdSchema,
    content: z.string().max(MOBILE_MAX_MESSAGE_CHARS),
    at: MobileDateSchema,
    status: z.enum(['complete', 'streaming', 'interrupted', 'error']),
    error: z.string().max(1_000).optional(),
    stopReason: z.enum(['stop', 'length', 'cancelled']).optional(),
    providerId: MobileProviderIdSchema.optional(),
  })
  .strict()
  .refine((message) => message.role === 'assistant' || message.status === 'complete', {
    message: 'Only assistant messages can have an unfinished status',
  });
export type MobileMessage = z.infer<typeof MobileMessageSchema>;

export const MobileSessionSchema = ChatSessionSchema.pick({
  id: true,
  gezelId: true,
  projectId: true,
  title: true,
  createdAt: true,
  lastActivityAt: true,
})
  .extend({
    id: MobileIdSchema,
    gezelId: z.literal('meester'),
    projectId: z.literal('default'),
    title: z.string().min(1).max(100),
    createdAt: MobileDateSchema,
    lastActivityAt: MobileDateSchema,
    messages: z.array(MobileMessageSchema).max(MOBILE_MAX_MESSAGES),
  })
  .strict();
export type MobileSession = z.infer<typeof MobileSessionSchema>;

/** Mobile owns a bounded foreground slice; it is not a desktop-home directory dump. */
export const MobileStateSchema = z
  .object({
    version: z.literal(1),
    gezel: MobileGezelSchema,
    project: MobileProjectSchema,
    sessions: z.array(MobileSessionSchema).min(1).max(MOBILE_MAX_SESSIONS),
    activeSessionId: MobileIdSchema,
    selectedProviderId: MobileProviderIdSchema.default('llama-cpp'),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.gezel.poppetje.key !== state.gezel.id) {
      ctx.addIssue({ code: 'custom', message: 'The poppetje wood-grain key must match its gezel' });
    }
    const ids = new Set<string>();
    let streaming = 0;
    for (const session of state.sessions) {
      if (ids.has(session.id))
        ctx.addIssue({ code: 'custom', message: 'Duplicate conversation id' });
      ids.add(session.id);
      const messageIds = new Set<string>();
      for (const [index, message] of session.messages.entries()) {
        if (message.role !== (index % 2 === 0 ? 'user' : 'assistant')) {
          ctx.addIssue({
            code: 'custom',
            message: 'Mobile messages must form user and assistant pairs',
          });
        }
        if (messageIds.has(message.id))
          ctx.addIssue({ code: 'custom', message: 'Duplicate message id' });
        messageIds.add(message.id);
        if (message.status === 'streaming') {
          streaming++;
          if (session.id !== state.activeSessionId) {
            ctx.addIssue({
              code: 'custom',
              message: 'An unfinished response must belong to the active conversation',
            });
          }
          if (index !== session.messages.length - 1) {
            ctx.addIssue({
              code: 'custom',
              message: 'An unfinished response must be the final message',
            });
          }
        }
      }
      if (session.messages.length % 2 !== 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each user message must retain its assistant response record',
        });
      }
    }
    if (!ids.has(state.activeSessionId))
      ctx.addIssue({ code: 'custom', message: 'Active conversation is missing' });
    if (streaming > 1)
      ctx.addIssue({ code: 'custom', message: 'Only one mobile response may be active' });
  });
export type MobileState = z.infer<typeof MobileStateSchema>;

export const MobileSnapshotSchema = z
  .object({
    state: MobileStateSchema,
    activeRequestId: MobileIdSchema.nullable(),
    persistenceError: z.string().max(1_000).nullable(),
    cancellationError: z.string().max(1_000).nullable().default(null),
  })
  .strict();
export type MobileSnapshot = z.infer<typeof MobileSnapshotSchema>;
