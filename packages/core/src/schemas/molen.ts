import { z } from 'zod';

/**
 * Checking a Molen document a gezel wrote: a film (`molen/film@1`), a game
 * (`molen/game@1`) or a data-only scene (`molen/scene@3`). The daemon owns the
 * check (it holds `@bendyline/molen-stage`); the MCP write tools, `validate`
 * and the `molenDocument` gate check all ask it, so they agree.
 */

export const MolenDocumentKindSchema = z.enum(['film', 'game', 'scene']);
export type MolenDocumentKind = z.infer<typeof MolenDocumentKindSchema>;

export const MolenCheckRequestSchema = z.object({
  /** The document itself, or its text exactly as written (parsed by the daemon). */
  document: z.unknown(),
});
export type MolenCheckRequest = z.infer<typeof MolenCheckRequestSchema>;

export const MolenCheckIssueSchema = z.object({
  /** JSON Pointer into the document, e.g. `/beats/2/who`. */
  path: z.string(),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});
export type MolenCheckIssue = z.infer<typeof MolenCheckIssueSchema>;

export const MolenCheckResponseSchema = z.object({
  /** It plays: a film or game compiles, or a scene validates with no scripts. */
  ok: z.boolean(),
  /** Which document it is; null when it is not one of the three. */
  kind: MolenDocumentKindSchema.nullable(),
  /** When `ok`: one plain line, e.g. `a film "The Meeting" 9.0 s long with 3 cast members and 1 prop`. */
  summary: z.string().optional(),
  /** When not `ok`: what blocks it. */
  issues: z.array(MolenCheckIssueSchema),
  /** When `ok`: what a viewer or play test would notice (someone hidden behind a prop). */
  notices: z.array(MolenCheckIssueSchema),
  /** The issues as Molen formats them for a model: numbered, with paths and hints. */
  formatted: z.string().optional(),
});
export type MolenCheckResponse = z.infer<typeof MolenCheckResponseSchema>;
