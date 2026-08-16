/**
 * `prompt.documents-summaries` — render the shared-documents listing as
 * `path — what it is` instead of bare paths.
 *
 * A path alone makes the model guess: `mission.md` and `notes-2024.md` are
 * indistinguishable until something reads them, so a model either reads
 * several documents to find one or answers without consulting any. A single
 * line of description turns the listing into something it can route on.
 *
 * Marker behavior (no config, no hooks): `buildInstructions` reads its
 * presence off the resolved profile, the same shape as
 * `prompt.workspace-gestalt`.
 *
 * Tier-gated rather than universal because it trades tokens for judgement:
 * descriptions roughly triple the block, which is worth it where there is
 * attention to spend and wasteful on a small local model that should be
 * steered to `search_documents` instead.
 */

import type { Behavior } from '../types.js';

export const PromptDocumentsSummaries: Behavior = {
  id: 'prompt.documents-summaries',
  description:
    'Renders each shared-library document with a one-line description (authored frontmatter first, else the indexed summary) so the model can pick a document without reading several.',
};
