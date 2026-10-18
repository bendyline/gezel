import {
  type BriefRoutableType,
  type SuggestWorkResult,
  type SuggestedWorkItem,
  type WorkCraftbookCandidate,
  briefAsksForBuild,
  fillProjectTypeParams,
  matchProjectTypeForBrief,
  projectTypesMentionedByBrief,
  rankWorkOptions,
  scoreCandidate,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  explicitlyRequestsSeparateProject,
  looksLikeNewBuildRequest,
  looksLikeProcedureRequest,
  namesDocumentDeliverable,
} from '@bendyline/gezel/local-loop';
import { triggerCandidateIsLaunchable } from '../chat/craftbook-trigger-route.js';
import {
  looksLikeImplementationRequest,
  looksLikeWorkRequest,
  resolveTurnIntentPlan,
} from '../chat/turn-intent-plan.js';
import { type ProjectGitStatusReader, listProjectCraftbookOffer } from '../craftbook/applicable.js';
import { rankCraftbookSuggestions, suggestCraftbooks } from '../craftbook/suggest.js';
import type { Store } from '../fs/store.js';

/**
 * Gather the candidates of every kind for one request and rank them with
 * core's fixed policy order (`rankWorkOptions`). This is what `suggest_work`
 * returns and what the `prompt.work-options-prelude` arm injects.
 *
 * Floors are applied here, per kind, because they belong to the scorer that
 * produced them: a craftbook's blended cosine means nothing to a project
 * type's tag hit. Every detector is the one the old routing surface already
 * trusted (the build and craftbook preludes, the turn-intent exact routes,
 * brief routing), so the two arms disagree about presentation, not about
 * what the request is.
 */

export interface WorkSuggestionDeps {
  catalog: CatalogService;
  store: Store;
  git?: ProjectGitStatusReader;
  /** Recurring work on offer in a project; omitted where it is not wired. */
  listSuggestedWork?: (projectId: string) => Promise<SuggestedWorkItem[]>;
}

export interface SuggestWorkInput {
  request: string;
  projectId: string;
  /** The asking session's model-facing tools, for the self and specialist verdicts. */
  tools?: readonly string[];
  /** Test seam for craftbook ranking. */
  rankCraftbooks?: typeof suggestCraftbooks;
  /** Test seam for ranking project types on meaning. */
  rankTypes?: typeof rankCraftbookSuggestions;
  /** Test seam for the project's craftbook listing. */
  listOffer?: typeof listProjectCraftbookOffer;
}

export const DEFAULT_PROJECT_ID = 'default';

/**
 * Craftbook floors, measured on the route-probe sentences against the gilde
 * 0.2.3 catalog with bge-small (2026-10-16). Unrelated books scored 0.34–0.42
 * blended for a person's sentence and correct ones 0.41–0.58, so no absolute
 * floor separates them on its own: 0.40 drops the bottom of the noise band,
 * and a book more than 0.06 behind the best is not offered beside it.
 * Without embeddings the score is token overlap alone, on its own scale.
 */
const CRAFTBOOK_FLOOR_BLENDED = 0.4;
const CRAFTBOOK_FLOOR_LEXICAL = 0.07;
const CRAFTBOOK_MAX_BEHIND_TOP = 0.06;
/** A book good enough to stand beside "answer it yourself" for a question. */
const CRAFTBOOK_STRONG_BLENDED = 0.5;
const CRAFTBOOK_STRONG_LEXICAL = 0.25;
/**
 * A short request whose best book is this weak is vague, not specific: "help
 * me with my thing for work" scored 0.42 on a knowledge-base book. It gets
 * the ask verdict instead of a list of guesses.
 */
const VAGUE_MAX_WORDS = 8;
const VAGUE_TOP_SCORE = 0.45;
const MAX_CRAFTBOOKS = 3;
/**
 * A routing turn waits this long for an embedder that is still loading, then
 * ranks on words. A cached model loads in about a second; a first download
 * held the first reply about 45 s (S1, 2026-10-17).
 */
const COLD_EMBEDDER_BUDGET_MS = 3_000;

/**
 * A project type the words do not tag can still be the clear fit: "I'd like
 * to practice my Spanish" names none of Language Trainer's tags. On the same
 * probes every correct type led its runner-up by 0.076 or more and scored at
 * least 0.41; no other request's best type led by more than 0.032. A type is
 * offered on meaning alone only when it clearly stands out like that.
 */
const TYPE_FLOOR_BLENDED = 0.4;
const TYPE_MIN_LEAD = 0.06;
/**
 * A catch-all type ("Chat: a quiet room for talking … asking questions") sits
 * near every conversational sentence, so it is no rival to a specific type.
 * Counted as one, it held Language Trainer to a 0.032 lead on "Can you help me
 * get better at French conversation?"; measured against the next specific
 * type the lead is 0.084, and no other probe's lead moved (2026-10-17).
 */
const CATCH_ALL_TYPE_CATEGORY = 'general';

const RECURRING_WORDING_RE =
  /\b(?:nightly|overnight|night\s+shift|every\s+(?:night|day|week|month|morning)|each\s+(?:night|day|week|month)|weekly|daily|monthly|recurring|on\s+a\s+schedule|turn\s+on|switch\s+on|enable)\b/i;
const STOP_WORDING_RE = /\b(?:stop|pause|turn\s+off|switch\s+off|disable|no\s+longer)\b/i;
const RECURRING_MATCH_FLOOR = 0.2;

const SELF_TOOL_ORDER = ['search', 'search_documents', 'search_memory', 'list_tasks', 'get_task'];

export async function suggestWork(
  deps: WorkSuggestionDeps,
  input: SuggestWorkInput,
): Promise<SuggestWorkResult> {
  const request = input.request.trim();
  const projectId = input.projectId;
  const inDefault = projectId === DEFAULT_PROJECT_ID;
  const tools = new Set(input.tools ?? []);
  const separateProject = explicitlyRequestsSeparateProject(request);
  const offer = await (input.listOffer ?? listProjectCraftbookOffer)(
    deps.catalog,
    deps.store,
    projectId,
    {
      ...(deps.git ? { git: deps.git } : {}),
    },
  ).catch(() => null);
  const setupFor = (craftbookId: string): string[] =>
    (offer?.missingToolsets[craftbookId] ?? []).map((need) => need.toolsetId);
  const paramSchemas = new Map<string, unknown>();
  for (const item of offer?.items ?? []) {
    if (item.manifest.kind === 'craftbook-template') {
      paramSchemas.set(item.manifest.id, item.manifest.paramSchema);
    }
  }
  // start_work fills only a book's main content param from the message, so a
  // book that needs a picked file or another answer cannot start from chat:
  // tidy-spreadsheet was offered for a CSV clean-up, start_work failed on
  // "Choose the spreadsheet", and Gemma asked instead of launching
  // dataset-clean (2026-10-17).
  const launchable = (craftbookId: string): boolean =>
    triggerCandidateIsLaunchable(paramSchemas.get(craftbookId));

  const plan = resolveTurnIntentPlan({ text: request, isMeester: true });
  const exactPlan =
    plan.route === 'craftbook' && plan.reason === 'exact-output-format' ? plan : null;
  // The same invocation the turn-intent exact route hands invoke_craftbook,
  // so both arms launch the book with the same topic.
  const exactRoute = exactPlan?.craftbook ? exactPlan : null;
  const exact: WorkCraftbookCandidate | undefined = exactRoute?.craftbook
    ? {
        craftbookId: exactRoute.craftbook.id,
        name: exactRoute.craftbook.name,
        description: `Produces a real ${exactRoute.output?.label ?? 'file'}.`,
        setupRequired: setupFor(exactRoute.craftbook.id),
        ...(exactRoute.craftbook.invocation.params
          ? { params: stringParams(exactRoute.craftbook.invocation.params) }
          : {}),
      }
    : undefined;

  const [ranked, projectTypes, recurring] = exact
    ? [{ candidates: [], vague: false }, [], []]
    : await Promise.all([
        rankedCraftbooks(deps, input, request, setupFor, launchable),
        inDefault || separateProject
          ? fittingProjectTypes(deps.catalog, request, input.rankTypes ?? rankCraftbookSuggestions)
          : [],
        matchingRecurringWork(deps, projectId, request),
      ]);
  // A short request no book fits well is vague: it gets the ask verdict, not
  // a list of guesses ("help me with my thing for work" scored 0.42 on a
  // knowledge-base book).
  const craftbooks = projectTypes.length === 0 && ranked.vague ? [] : ranked.candidates;

  return rankWorkOptions({
    request,
    projectId,
    inDefault,
    workRequest: looksLikeWorkRequest(request),
    ...(exact ? { exact } : {}),
    projectTypes,
    craftbooks,
    recurring,
    newProject:
      looksLikeNewBuildRequest(request) && (!namesDocumentDeliverable(request) || separateProject),
    separateProject,
    procedure: looksLikeProcedureRequest(request),
    implementation: looksLikeImplementationRequest(request),
    selfTools: selfTools(tools),
    ...(tools.has('delegate_developer')
      ? { specialist: { role: 'developer', tool: 'delegate_developer' } }
      : {}),
  });
}

async function rankedCraftbooks(
  deps: WorkSuggestionDeps,
  input: SuggestWorkInput,
  request: string,
  setupFor: (craftbookId: string) => string[],
  launchable: (craftbookId: string) => boolean,
): Promise<{ candidates: WorkCraftbookCandidate[]; vague: boolean }> {
  const rank = input.rankCraftbooks ?? suggestCraftbooks;
  const ranked = await rank(
    { catalog: deps.catalog, store: deps.store, ...(deps.git ? { git: deps.git } : {}) },
    {
      projectId: input.projectId,
      query: request,
      topK: MAX_CRAFTBOOKS * 2,
      coldEmbedderBudgetMs: COLD_EMBEDDER_BUDGET_MS,
    },
  ).catch(() => []);
  // Unlaunchable books leave before the trailing cut, so the best book a
  // message can start is measured against its own peers.
  const suggestions = ranked.filter((s) => launchable(s.id)).slice(0, MAX_CRAFTBOOKS);
  const best = suggestions[0];
  const top = best?.score ?? 0;
  const candidates = suggestions
    .filter((s) =>
      s.semantic !== undefined
        ? s.score >= CRAFTBOOK_FLOOR_BLENDED && s.score >= top - CRAFTBOOK_MAX_BEHIND_TOP
        : s.score >= CRAFTBOOK_FLOOR_LEXICAL,
    )
    .map((s) => ({
      craftbookId: s.id,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      setupRequired: setupFor(s.id),
      strong:
        s.lexical >= CRAFTBOOK_STRONG_LEXICAL ||
        (s.semantic !== undefined && s.score >= CRAFTBOOK_STRONG_BLENDED),
    }));
  const vague =
    best?.semantic !== undefined &&
    top < VAGUE_TOP_SCORE &&
    request.split(/\s+/).filter(Boolean).length <= VAGUE_MAX_WORDS;
  return { candidates, vague };
}

type TypeCandidate = { typeId: string; name: string; description?: string };

/**
 * Types the request fits whose required details it also carries: a type that
 * cannot be filled from the sentence would open on its schema placeholder, so
 * it is not offered. Brief routing's tag match goes first, ties after it,
 * then a type that clearly leads on meaning alone (see TYPE_MIN_LEAD). A
 * request to build software is never a type, as in brief routing.
 */
async function fittingProjectTypes(
  catalog: CatalogService,
  request: string,
  rankTypes: typeof rankCraftbookSuggestions,
): Promise<TypeCandidate[]> {
  const items = await catalog.list('project-type').catch(() => []);
  const types = items
    .filter((item) => !item.unavailableReason)
    .map(
      (item) =>
        item.manifest as unknown as BriefRoutableType & {
          description?: string;
          version?: string;
          category?: string;
        },
    );
  const fillable = (id: string) => {
    const type = types.find((t) => t.id === id);
    return type && fillProjectTypeParams(type.params, request) ? type : null;
  };
  const primary = matchProjectTypeForBrief(request, types)?.typeId;
  const ids = [
    ...(primary ? [primary] : []),
    ...projectTypesMentionedByBrief(request, types).filter((id) => id !== primary),
  ];
  if (!briefAsksForBuild(request)) {
    // Type ids share the suggester's vector cache with craftbook ids.
    const ranked = await rankTypes(
      request,
      types.map((t) => ({
        id: `type:${t.id}`,
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.tags ? { tags: [...t.tags] } : {}),
        source: 'bundled' as const,
        ...(t.version ? { version: t.version } : {}),
        stepCount: 1,
      })),
      { topK: 3, minScore: 0, coldEmbedderBudgetMs: COLD_EMBEDDER_BUDGET_MS },
    ).catch(() => []);
    const catchAll = new Set(
      types.filter((t) => t.category === CATCH_ALL_TYPE_CATEGORY).map((t) => `type:${t.id}`),
    );
    const [best, ...rest] = ranked;
    const next = rest.find((r) => !catchAll.has(r.id));
    if (
      best?.semantic !== undefined &&
      best.score >= TYPE_FLOOR_BLENDED &&
      best.score - (next?.score ?? 0) >= TYPE_MIN_LEAD
    ) {
      ids.push(best.id.slice('type:'.length));
    }
  }
  const out: TypeCandidate[] = [];
  for (const id of [...new Set(ids)]) {
    const type = fillable(id);
    if (!type) continue;
    out.push({
      typeId: type.id,
      name: type.name,
      ...(type.description ? { description: type.description } : {}),
    });
  }
  return out;
}

async function matchingRecurringWork(
  deps: WorkSuggestionDeps,
  projectId: string,
  request: string,
): Promise<Array<{ key: string; name: string; description?: string; pause: boolean }>> {
  if (!deps.listSuggestedWork) return [];
  const stopping = STOP_WORDING_RE.test(request);
  if (!stopping && !RECURRING_WORDING_RE.test(request)) return [];
  const items = await deps.listSuggestedWork(projectId).catch(() => []);
  return items
    .filter((item) => (stopping ? item.state === 'enabled' : item.state !== 'enabled'))
    .filter((item) => item.state !== 'dismissed')
    .map((item) => ({
      item,
      score: scoreCandidate(request, {
        id: item.craftbookId,
        name: item.craftbookName ?? item.craftbookId,
        ...(item.description ? { description: item.description } : {}),
      }).score,
    }))
    .filter(({ score }) => score >= RECURRING_MATCH_FLOOR)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => ({
      key: item.key,
      name: `${stopping ? 'Pause' : 'Switch on'} ${item.craftbookName ?? item.craftbookId} (${item.runMode === 'night-shift' ? 'night shift' : 'scheduled'})`,
      ...(item.reason ? { description: item.reason } : {}),
      pause: stopping,
    }));
}

function stringParams(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function selfTools(tools: ReadonlySet<string>): string[] {
  const consults = [...tools].filter((name) => name.startsWith('consult_')).sort();
  const helpers = SELF_TOOL_ORDER.filter((name) => tools.has(name));
  return [...consults.slice(0, 3), ...helpers].slice(0, 4);
}
