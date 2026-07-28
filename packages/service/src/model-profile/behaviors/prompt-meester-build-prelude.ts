/**
 * `prompt.meester-build-prelude` — when the active gezel is the
 * configured Meester AND the user's turn looks like a "build me a
 * substantive thing" ask, prepend a short system note steering the
 * model toward the right project-starting macro first.
 *
 * The wild-caught failure mode this targets: Gemma 26B recruiting a
 * Builder template *before* `create_project`, then fabricating
 * "I've initialized the project" without ever creating it. The
 * prelude lands in the user-prompt slot (where local-model attention
 * is highest) so the rule is anchored before the model commits to a
 * tool-call sequence.
 *
 * Migrated verbatim from `chat/manager.ts`'s `MEESTER_BUILD_PRELUDE`,
 * `BUILD_VERBS`, `BUILD_NOUNS`, and `BUILD_REQUEST_RE`. The exported
 * helper {@link looksLikeNewBuildRequest} is also re-exported for
 * tests + any consumer that wants the same gating heuristic outside
 * the runtime hook (currently none, but keeping the surface lets
 * future fabrication-detector behaviors share it).
 */

import type { Behavior } from '../types.js';

/**
 * Verbs that imply a new substantive build in user prose. Narrow on
 * verbs and rely on the noun list for real disambiguation: "create"
 * can mean many things; "create a game" is a build request, "create
 * a memory" is not.
 */
const BUILD_VERBS = [
  'build',
  'create',
  'make',
  'set\\s+up',
  'spin\\s+up',
  'start',
  'kick\\s+off',
  'ship',
  'put\\s+together',
  'whip\\s+up',
  'prototype',
  'scaffold',
];

/**
 * Nouns that count as a substantive build target. Deliberately
 * excludes `task` / `gezel` / `voorman` / `memory` / `note` /
 * `artifact` — those have their own creation tools and would
 * mis-fire the create_project hint.
 */
const BUILD_NOUNS = [
  'project',
  'game',
  'app',
  'application',
  'website',
  'site',
  'webapp',
  'web\\s+app',
  'tool',
  'service',
  'bot',
  'dashboard',
  'plugin',
  'extension',
  'library',
  'api',
  'cli',
  'agent',
  'integration',
  'page',
  'portfolio',
  'landing\\s+page',
  'marketing\\s+site',
  'newsletter',
  'crew',
  'team',
  'workspace',
];

const BUILD_REQUEST_RE = new RegExp(
  String.raw`\b(?:can\s+(?:we|you)\s+(?:please\s+)?|let'?s\s+|please\s+|i\s+(?:want\s+to|need\s+to|'?d\s+like\s+to)\s+|i\s+wanna\s+|help\s+me\s+)?` +
    String.raw`(?:` +
    BUILD_VERBS.join('|') +
    String.raw`)\s+(?:me\s+)?(?:a|an|the|some|my|our)?\s*` +
    // Allow up to 5 qualifier words between the article and the noun
    // ("a new Space Invaders game", "a small Stripe webhooks service",
    // "an internal admin dashboard"). Lazy so the noun anchor wins
    // over a greedy span.
    String.raw`(?:[\w'-]+\s+){0,5}?` +
    String.raw`(?:` +
    BUILD_NOUNS.join('|') +
    String.raw`)\b`,
  'i',
);

/**
 * Detect a "build something substantive" request in user prose. The
 * regex matches optional polite/intent prefixes ("can we", "let's",
 * "I want to", "help me", …) plus a build verb plus a build noun.
 * False-positive rate is dominated by verb/noun overlap — `create a
 * task` is excluded by leaving `task` off the noun list.
 */
export function looksLikeNewBuildRequest(text: string): boolean {
  return BUILD_REQUEST_RE.test(text);
}

const SINGLE_SPECIALIST_RE =
  /\b(?:single[-\s]?file|one[-\s]?file|one[-\s]?shot|quick prototype|just for me|all in (?:one )?(?:file|index\.html)|everything in (?:one )?(?:file|index\.html)|index\.html|no build(?: step)?|without a build step)\b/i;

export function looksLikeSingleSpecialistBuildRequest(text: string): boolean {
  return SINGLE_SPECIALIST_RE.test(text);
}

const MEESTER_CREW_BUILD_PRELUDE =
  '(System note for this turn: the user is asking for a new substantive build. Make ONE tool call:\n' +
  ' • `start_project({ name, about, missionObjectives, taskDescription })`. Creates a fresh project, recruits a voorman, wires them in as lead, creates the kickoff task, and hands the crew its entry step (the work starts in a task-scoped session). Use this for "build me a website / game / app / dashboard" and ALL multimodal asks (e.g. site AND logo, code AND tests AND docs). `taskDescription` must ask the lead to ship the actual requested deliverable, not to create a plan. For browser games/sites, name `workspace/index.html` and the acceptance criteria.\n' +
  ' • Do not use `start_job` unless the user explicitly scoped the work to one specialist ("quick prototype", "one-shot", "just for me", "single HTML file", "no build step").\n' +
  'After the macro returns, your turn is done — tell the user the lead/specialist is on it. Do NOT call `create_gezel`, `update_project`, `create_task`, or `message_gezel` separately — the macro handles them. Do NOT reuse the existing "Default" project; the macro creates a fresh dedicated one.)';

const MEESTER_SINGLE_JOB_PRELUDE =
  '(System note for this turn: the user asked for a one-specialist deliverable. Make ONE tool call:\n' +
  ' • `start_job({ name, about, missionObjectives, taskDescription, specialistRole })`. Use `specialistRole: "builder"` or `"developer"` for code. `taskDescription` must tell the specialist to deliver the requested file, not a plan. For source code say to write `index.html` with `writeFile` (workspace-relative path; do not prefix `workspace/`). Preserve the acceptance criteria.\n' +
  ' • Do NOT call `start_project` for this single-file / no-build-step request. Do NOT call `create_gezel`, `update_project`, `create_task`, or `message_gezel` separately — the macro handles them.\n' +
  'After the macro returns, your turn is done — tell the user which specialist is on it.)';

export const PromptMeesterBuildPrelude: Behavior = {
  id: 'prompt.meester-build-prelude',
  description:
    'Prepends a system note to the user prompt when the active gezel is the Meester and the message looks like a "build me X" request, anchoring the first-call expectation on `start_project` or `start_job`.',

  userPromptPrelude(ctx) {
    if (!ctx.isMeester) return null;
    if (!looksLikeNewBuildRequest(ctx.userText)) return null;
    if (looksLikeSingleSpecialistBuildRequest(ctx.userText)) {
      return MEESTER_SINGLE_JOB_PRELUDE;
    }
    return MEESTER_CREW_BUILD_PRELUDE;
  },
};
