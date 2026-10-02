import { z } from 'zod';
import { ProviderNameSchema } from '../gezel.js';

/**
 * One bounded model call made on behalf of a repository workflow
 * (`POST /api/projects/:id/completions`). The driver supplies the whole
 * input inline and gets the answer back in the response: no tools, no
 * session, no transcript. Owner/CLI clients only; model sessions cannot
 * reach it.
 */
export const ProjectCompletionRequestSchema = z.object({
  /** Answer with this gezel's provider and model. Its about.md is not injected. */
  gezelId: z.string().min(1).optional(),
  /** Overrides the gezel's (or the install default) provider. */
  provider: ProviderNameSchema.optional(),
  /** Overrides the gezel's (or the provider default) model id. */
  model: z.string().min(1).optional(),
  /** Verbatim system message. Omit for none. */
  system: z.string().max(200_000).optional(),
  prompt: z.string().min(1).max(2_000_000),
  /** Constrain the answer to this JSON Schema (llama.cpp grammar, OpenAI strict mode). */
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Output ceiling, reasoning included. */
  maxTokens: z.number().int().positive().max(262_144).optional(),
  /** False answers without a reasoning phase on models that have one. */
  thinking: z.boolean().optional(),
  /** Awake-time budget including queue wait. Default 10 minutes. */
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  /** Short label shown in the engine queue, e.g. "check · Taylorville ¶3". */
  label: z.string().min(1).max(120).optional(),
});
export type ProjectCompletionRequest = z.infer<typeof ProjectCompletionRequestSchema>;

export const ProjectCompletionResponseSchema = z.object({
  content: z.string(),
  /** Parsed answer when `jsonSchema` was given and the content parsed. */
  json: z.unknown().optional(),
  /** Why the content did not parse as JSON, when `jsonSchema` was given. */
  jsonError: z.string().optional(),
  elapsedMs: z.number(),
});
export type ProjectCompletionResponse = z.infer<typeof ProjectCompletionResponseSchema>;
