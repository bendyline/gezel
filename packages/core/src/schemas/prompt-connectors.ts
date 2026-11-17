import { z } from 'zod';

/**
 * Connections a draft calls for. A person writes a message; a rule finds
 * something in it a connector could serve (today: a web address the website
 * connector can save), and the composer says what will happen before Send.
 * Rules are in `prompt-connectors/`; the contract is docs/prompt-connectors.md.
 */

/**
 * What accepting an offer does.
 * - `include`: fetch that one thing into the project and hand it to the chat.
 *   It needs nothing more from the person, so Send does it unless they
 *   dismissed the offer.
 * - `connect`: set up a connection (a sign-in, a choice of folder). Never
 *   automatic: the offer opens the Connections form.
 */
export const PromptConnectorEffectSchema = z.enum(['include', 'connect']);
export type PromptConnectorEffect = z.infer<typeof PromptConnectorEffectSchema>;

export const PromptConnectorOfferSchema = z.object({
  /** The rule that found it; with `subject`, the offer's identity. */
  rule: z.string(),
  /** Catalog connector type that would serve it. */
  connectorType: z.string(),
  effect: PromptConnectorEffectSchema,
  /** What the rule found, normalized: a web address. */
  subject: z.string(),
  /** How a person reads the subject: `gezel.com/platform`. */
  label: z.string(),
  /** The connector type's catalog name and artwork, for the strip's mark. */
  typeName: z.string().optional(),
  typeTags: z.array(z.string()).optional(),
  logoUrl: z.string().optional(),
  /** Untrusted until structurally sanitized, as on any catalog item. */
  iconSvg: z.string().optional(),
});
export type PromptConnectorOffer = z.infer<typeof PromptConnectorOfferSchema>;

/** `POST /api/projects/:id/prompt-connectors/offers` */
export const PromptConnectorOffersRequestSchema = z.object({
  text: z.string().max(400_000),
});
export type PromptConnectorOffersRequest = z.infer<typeof PromptConnectorOffersRequestSchema>;

export const PromptConnectorOffersResponseSchema = z.object({
  /** Only what is not already served: a saved page is never offered again. */
  offers: z.array(PromptConnectorOfferSchema),
});
export type PromptConnectorOffersResponse = z.infer<typeof PromptConnectorOffersResponseSchema>;

/**
 * What a connector brought into one user turn because the person named it.
 * Stamped on the stored user message, so the thread shows the saved copy and
 * a rebuilt session knows what the turn was given. `path` absent with a
 * `reason` means the attempt failed and nothing was included.
 */
export const PromptInclusionSchema = z.object({
  connectorType: z.string(),
  /** What the person named: the address. */
  subject: z.string(),
  label: z.string().optional(),
  title: z.string().optional(),
  /** Artifact-relative path of the saved copy. */
  path: z.string().optional(),
  /** A short synopsis. Untrusted: derived from the item's own text. */
  summary: z.string().optional(),
  /** Plain-language reason nothing was included. */
  reason: z.string().optional(),
});
export type PromptInclusion = z.infer<typeof PromptInclusionSchema>;

/** `POST /api/projects/:id/prompt-connectors/accept`: the person takes one offer now. */
export const AcceptPromptConnectorRequestSchema = z.object({
  rule: z.string().min(1).max(80),
  subject: z.string().min(1).max(4000),
});
export type AcceptPromptConnectorRequest = z.infer<typeof AcceptPromptConnectorRequestSchema>;

export const AcceptPromptConnectorResponseSchema = z.object({
  inclusion: PromptInclusionSchema,
});
export type AcceptPromptConnectorResponse = z.infer<typeof AcceptPromptConnectorResponseSchema>;
