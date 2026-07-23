/**
 * `prompt.meester-craftbook-prelude` — when the active gezel is the
 * configured Meester AND the user's turn asks for a REPEATABLE
 * procedure (a recipe/playbook/workflow, or "every week"-shaped
 * recurring work), prepend a system note steering the model onto the
 * craftbook surface: find a library recipe first, else author one as
 * a single document.
 *
 * The wild-caught failure this targets (craftbook format A/B,
 * qwen3.6-27b): asked point-blank to reuse or author a
 * recipe — with `suggest_craftbook` / `craftbook_write` verifiably in
 * its tool list — the meester delegated the whole job as ad-hoc
 * `writeFile` work in 3 of 4 steered trials. Per-message kickoff
 * steering loses to the delegation-heavy meester persona; this
 * prelude lands in the user-prompt slot (where local-model attention
 * is highest), the same mechanism that fixed the analogous
 * start_project adoption gap (`prompt.meester-build-prelude`).
 *
 * Universal default (registry): self-gates on `isMeester` plus a
 * narrow procedure/recurrence regex, so it is inert on every other
 * turn. Walk order note: manifests that carry the build prelude list
 * it BEFORE universal defaults, so a generic "build me a website"
 * still routes to `start_project` (which pins a craftbook itself);
 * this prelude only wins turns the build regex doesn't claim.
 */

import type { Behavior } from '../types.js';

/**
 * Craftbook-shaped nouns. `process`/`workflow` are only counted when
 * followed by `for`/`to` ("a process for handling refunds") to keep
 * incidental uses ("trust the process") from firing.
 */
const PROCEDURE_NOUN_RE =
  /\b(?:recipe|craftbook|playbook|runbook|checklist|routine|standard\s+procedure|procedure\s+(?:for|to)|process\s+(?:for|to)|workflow\s+(?:for|to))\b/i;

/** Recurrence phrasing: the "I'll need this again" signal. */
const RECURRENCE_RE =
  /\b(?:reusable|repeatable|recurring|not\s+a\s+one[-\s]off|every\s+(?:day|week|month|morning|monday|time)|each\s+(?:day|week|month|time)|whenever\s+\w|again\s+and\s+again|on\s+a\s+schedule)\b/i;

/** Explicit pointer at the existing library — the "find" half of find-or-author. */
const LIBRARY_RE =
  /\b(?:recipe\s+library|craftbook\s+library|existing\s+(?:recipe|craftbook|playbook)|library\s+(?:recipe|craftbook)|which\s+(?:recipe|craftbook)|(?:reuse|use)\s+(?:a|an|the|one\s+of\s+(?:the|our))\s+(?:existing\s+)?(?:recipe|craftbook)s?)\b/i;

export function looksLikeProcedureRequest(text: string): boolean {
  return PROCEDURE_NOUN_RE.test(text) || RECURRENCE_RE.test(text);
}

export function looksLikeLibraryLookupRequest(text: string): boolean {
  return LIBRARY_RE.test(text);
}

/**
 * One-off data-transform asks — the task CLASS the data craftbooks
 * (dataset-clean, csv-transformer, data-pipeline-etl) exist for. Verb
 * AND noun must both appear: "clean this dataset" fires, "clean up the
 * wording" (no data noun) and "open the csv" (no transform verb) do
 * not. Kept separate from the procedure/recurrence gate because these
 * asks are usually phrased as one-offs, yet ad-hoc delegation loses the
 * books' integrity gates (dedup keys, value conservation) exactly where
 * they matter most. Wild-caught (core-sweep follow-ups):
 * every meester given a normalize-and-dedupe ask delegated it raw and
 * the gated books never ran.
 */
const DATA_TRANSFORM_VERB_RE =
  /\b(?:clean(?:\s*up)?|normali[sz]\w*|dedup\w*|de-dup\w*|merg\w*|consolidat\w*|reconcil\w*|standardi[sz]\w*|wrangl\w*|tidy\w*|transform\w*|convert\w*|migrat\w*|restructur\w*|reformat\w*)\b/i;
const DATA_NOUN_RE =
  /\b(?:csv|tsv|xlsx?|spreadsheets?|datasets?|data\s*(?:set|file|dump|export)s?|records?|rows?|tabular|exports?)\b/i;

export function looksLikeDataTransformRequest(text: string): boolean {
  return DATA_TRANSFORM_VERB_RE.test(text) && DATA_NOUN_RE.test(text);
}

const MEESTER_CRAFTBOOK_SELECT_PRELUDE =
  '(System note for this turn: the user wants an existing recipe from the craftbook library. Do this yourself — do NOT delegate it and do NOT start hand-writing files:\n' +
  ' 1. `suggest_craftbook({ query })` with a short description of the job.\n' +
  ' 2. Pick the best match and `invoke_craftbook({ craftbookId, project })` — that creates the gated task and the crew executes its steps.\n' +
  'Only if nothing in the shortlist fits should you consider authoring a new craftbook or falling back to `start_project`.)';

const MEESTER_CRAFTBOOK_TRANSFORM_PRELUDE =
  '(System note for this turn: this is a data-transform job, and the craftbook library has gated recipes for exactly this class (cleaning, dedup, format conversion) whose runtime checks catch the classic integrity mistakes — renumbered ids, silent row drops. Route it through a recipe instead of delegating it raw:\n' +
  ' 1. `suggest_craftbook({ query })` with a short description of the transform.\n' +
  ' 2. `invoke_craftbook({ craftbookId, project })` on the TOP match — the crew executes the gated steps. Recipes like dataset-clean or csv-transformer fit almost any tabular cleanup.\n' +
  'This is a one-off job: do NOT author a new craftbook (`craftbook_write`) and do NOT hand-write task steps — invoking an existing recipe always beats both here. Only fall back to direct delegation if the shortlist is empty.)';

const MEESTER_CRAFTBOOK_AUTHOR_PRELUDE =
  '(System note for this turn: the user is asking for a REPEATABLE procedure, so the deliverable is a CRAFTBOOK — a reusable recipe — not a one-off. You have the tools for this; do it yourself, in this chat:\n' +
  ' 1. `suggest_craftbook({ query })` first — if a library recipe already fits, `invoke_craftbook` it and you are done.\n' +
  ' 2. Otherwise AUTHOR the recipe: `craftbook_read` any book with the full-document format to see the shape, then save yours in ONE call with `craftbook_write({ create: true, content })`. Give every build step a `deliverable` ({ path, kind }) so it is gated; put a completion-gated verify step last. If craftbook_write reports validation problems, fix them and resend the corrected FULL document.\n' +
  ' 3. Then `invoke_craftbook` it so the crew executes the steps.\n' +
  'Do NOT delegate the authoring to another gezel, and do NOT have anyone write the output files by hand first — files without a saved reusable craftbook do not satisfy a "repeatable" ask.)';

export const PromptMeesterCraftbookPrelude: Behavior = {
  id: 'prompt.meester-craftbook-prelude',
  description:
    'Prepends a system note when the Meester receives a repeatable-procedure ask, anchoring the find-or-author craftbook flow (suggest_craftbook → invoke_craftbook, else craftbook_write) before the delegation habit takes over.',

  userPromptPrelude(ctx) {
    if (!ctx.isMeester) return null;
    if (looksLikeLibraryLookupRequest(ctx.userText)) {
      return MEESTER_CRAFTBOOK_SELECT_PRELUDE;
    }
    if (looksLikeProcedureRequest(ctx.userText)) {
      return MEESTER_CRAFTBOOK_AUTHOR_PRELUDE;
    }
    if (looksLikeDataTransformRequest(ctx.userText)) {
      return MEESTER_CRAFTBOOK_TRANSFORM_PRELUDE;
    }
    return null;
  },
};
