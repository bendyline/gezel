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
 * Verbs that imply a new substantive goal in user prose. Narrow on
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
 * A goal to organize is a kickoff too ("plan a family trip to Portugal" went
 * unrouted, so the meester improvised a crew in chat), but only for an
 * occasion. Paired with the build nouns these verbs read "plan a team
 * meeting" and "organize the files in my workspace" as new projects.
 */
const PLAN_VERBS = ['plan', 'organi[sz]e', 'arrange'];
const OCCASION_NOUNS = [
  'trip',
  'vacation',
  'holiday',
  'itinerary',
  'getaway',
  'event',
  'party',
  'wedding',
  'reunion',
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
  'trip',
  'vacation',
  'holiday',
  'itinerary',
  'getaway',
  'event',
  'party',
  'wedding',
  'reunion',
];

function requestPattern(verbs: readonly string[], nouns: readonly string[]): RegExp {
  return new RegExp(
    String.raw`\b(?:can\s+(?:we|you)\s+(?:please\s+)?|let'?s\s+|please\s+|i\s+(?:want\s+to|need\s+to|'?d\s+like\s+to)\s+|i\s+wanna\s+|help\s+me\s+)?` +
      String.raw`(?:` +
      verbs.join('|') +
      String.raw`)\s+(?:me\s+)?(?:a|an|the|some|my|our)?\s*` +
      // Allow up to 5 qualifier words between the article and the noun
      // ("a new Space Invaders game", "a small Stripe webhooks service",
      // "an internal admin dashboard"). Lazy so the noun anchor wins
      // over a greedy span.
      String.raw`(?:[\w'-]+\s+){0,5}?` +
      String.raw`(?:` +
      nouns.join('|') +
      String.raw`)\b`,
    'i',
  );
}

const BUILD_REQUEST_RE = requestPattern(BUILD_VERBS, BUILD_NOUNS);
const PLAN_REQUEST_RE = requestPattern(PLAN_VERBS, OCCASION_NOUNS);

/**
 * A wish names the thing to build without a build verb: "I'd like a little
 * browser game where you guess a country's capital" is as much a new build
 * as "make a game", and with no verb suggest_work offered recipes instead of
 * a project (route-capital-quiz-game, 2026-10-21). Only software nouns, after
 * an indefinite article: "I need the page to load faster" is work on a thing
 * that exists, and "I'd like an app recommendation" is a question.
 */
const WISH_NOUNS = [
  'game',
  'app',
  'application',
  'website',
  'site',
  'webapp',
  'web\\s+app',
  'dashboard',
  'landing\\s+page',
  'portfolio',
  'bot',
  'plugin',
  'extension',
];
const WISH_REQUEST_RE = new RegExp(
  String.raw`\b(?:i(?:'?d|\s+would)\s+(?:like|love)|i\s+(?:want|need)|(?:could|can)\s+i\s+(?:get|have))\s+(?:a|an)\s+(?:[\w'-]+\s+){0,5}?(?:` +
    WISH_NOUNS.join('|') +
    String.raw`)\b(?!\s+(?:recommendations?|suggestions?|ideas?)\b)`,
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
  return BUILD_REQUEST_RE.test(text) || PLAN_REQUEST_RE.test(text) || WISH_REQUEST_RE.test(text);
}

/**
 * A document-shaped deliverable is craftbook work, which runs in the current
 * project — Default included. The noun list above matches the audience as
 * readily as the output, so "make me some slides for our team" read as a
 * team build and was told to start a project and "NOT reuse Default".
 */
const DOCUMENT_DELIVERABLE_RE =
  /\b(?:slides?|slide\s*show|deck|presentation|power\s*point|pptx?|report|document|docx|memo|letter|spreadsheet|pdf|one-pager|poster|flyer|essay|article|outline)\b/i;

export function namesDocumentDeliverable(text: string): boolean {
  return DOCUMENT_DELIVERABLE_RE.test(text);
}

/**
 * In an already-scoped project, a generic build request means "work here".
 * Starting another project requires explicit project/workspace language;
 * `new game` is deliberately insufficient because `new` describes the
 * deliverable, not a request to leave the current project.
 */
export function explicitlyRequestsSeparateProject(text: string): boolean {
  return (
    /\b(?:new|fresh|separate|another|dedicated)\s+(?:(?:standalone|independent)\s+)?(?:project|workspace)\b/i.test(
      text,
    ) ||
    /\b(?:as|in|into|under|for)\s+(?:a|an)\s+(?:new|fresh|separate|another|dedicated)\s+(?:project|workspace)\b/i.test(
      text,
    )
  );
}

const MEESTER_BUILD_PRELUDE =
  '(System note for this turn: the user is asking to start something new. Make ONE tool call:\n' +
  " • `start_project({ name, about, missionObjectives, taskDescription })`. Creates a fresh project, selects an appropriate lead/team for the goal (a trip gets a trip planner, a website a developer), creates the kickoff task, and hands it off (the work starts in a task-scoped session). Use this for every new goal — a website, game or app, a trip or an event, a plan to write up — from a single-file prototype through multimodal work. `taskDescription` must ask for the actual result, not a plan to make one, and keep the user's specifics (places, dates, names, numbers). Only for a browser game or site, name `index.html` and the acceptance criteria (workspace-relative path; do not prefix `workspace/`); for anything else name no file.\n" +
  'After the macro returns, your turn is done — tell the user in a sentence who is on it. Do NOT call `create_gezel`, `update_project`, `create_task`, or `message_gezel` separately — the macro handles them. Do NOT reuse the existing "Default" project; the macro creates a fresh dedicated one.)';

export const PromptMeesterBuildPrelude: Behavior = {
  id: 'prompt.meester-build-prelude',
  description:
    'Prepends a system note to the user prompt when the active gezel is the Meester and the message looks like a "build me X" request, anchoring the first-call expectation on `start_project`.',

  userPromptPrelude(ctx) {
    if (!ctx.isMeester) return null;
    if (ctx.messageOrigin !== 'direct-user') return null;
    if (/^\s*\[Answer to:/i.test(ctx.userText)) return null;
    if (!looksLikeNewBuildRequest(ctx.userText)) return null;
    if (
      namesDocumentDeliverable(ctx.userText) &&
      !explicitlyRequestsSeparateProject(ctx.userText)
    ) {
      return null;
    }
    if (ctx.projectId !== 'default' && !explicitlyRequestsSeparateProject(ctx.userText)) {
      return null;
    }
    if (!ctx.availableToolNames.includes('start_project')) return null;
    return MEESTER_BUILD_PRELUDE;
  },
};
