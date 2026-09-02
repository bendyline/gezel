import type { EvalContext, EvalScenario, SuccessCheckResult } from '../../types.ts';
import { findProjectIdByName } from '../shared.ts';
import {
  AUTHORING_PROJECT_PIN,
  authoredCraftbookSummaries,
  ensureAuthoringProject,
  findTaskForCraftbookAnywhere,
  finishAuthoringPoll,
  progressBytes,
  sendMeesterKickoff,
} from './helpers.ts';

/**
 * craftbook-find-vs-create — the SELECTION probe: given a brief that
 * paraphrases a bundled book's trigger domain, the model should FIND and
 * invoke the existing library recipe rather than authoring a new one.
 *
 * Target: the bundled `seo-meta-pack` template. The brief paraphrases
 * its domain (page titles, search snippets, social share cards) without
 * quoting the manifest, and explicitly says to check the recipe library
 * first. Success is cheap by design: a task sourced from the bundled id
 * with ZERO model-authored books — the trial ends at task creation (at
 * most first-gate progress), never demanding completion, to cap cost.
 */

const PROJECT_NAME = 'Shop Site Pages';

export const BUNDLED_CRAFTBOOK_ID = 'seo-meta-pack';

export const PAGE_FIXTURES: ReadonlyArray<{ path: string; content: string }> = [
  {
    path: 'pages/index.html',
    content:
      '<!doctype html>\n<html>\n<head><title>Home</title></head>\n' +
      '<body>\n<h1>Fieldstone Goods</h1>\n<p>Handmade homeware: mugs, notebooks, candles, and totes.</p>\n</body>\n</html>\n',
  },
  {
    path: 'pages/shipping.html',
    content:
      '<!doctype html>\n<html>\n<head><title>Page</title></head>\n' +
      '<body>\n<h1>Shipping &amp; returns</h1>\n<p>Free shipping over 60. Returns within 30 days.</p>\n</body>\n</html>\n',
  },
];

export const FIND_VS_CREATE_MISSION_OBJECTIVES = [
  'Get the shop site pages presentable in search results and in social shares: every page needs',
  'a proper page title, a search-snippet description, and share-preview card tags.',
  'Set the work up as a task in this project. Check the recipe library for an existing',
  'craftbook that covers this kind of work and use it — do not author a new recipe from',
  'scratch when the library already has one that fits.',
].join(' ');

export const FIND_VS_CREATE_KICKOFF_MESSAGE = [
  `Our shop site's pages (under pages/) look terrible when they show up in search results and`,
  'when people share them: the browser titles are placeholders, there are no search-snippet',
  'descriptions, and shared links get no preview card.',
  'Please set this up as a task in this project: every page needs a proper unique title, a',
  'concise description for the search snippet, and the tags that make social shares render a',
  'preview card.',
  'Before you build anything yourself, check the recipe library — if an existing craftbook',
  'covers this kind of page-metadata work, invoke that one to create the task. Do not author a',
  'new craftbook from scratch when the library already has a fitting recipe.',
  'Concretely: FIRST call suggest_craftbook with a short description of this job, then',
  'invoke_craftbook on the best match — do not start editing the page files by hand.',
  AUTHORING_PROJECT_PIN,
].join(' ');

async function setup(ctx: EvalContext): Promise<void> {
  const projectId = await ensureAuthoringProject(ctx, {
    name: PROJECT_NAME,
    about:
      'A small handmade-homeware shop site. The pages under pages/ need presentable search ' +
      'results and social share previews.',
    missionObjectives: FIND_VS_CREATE_MISSION_OBJECTIVES,
  });
  for (const fixture of PAGE_FIXTURES) {
    await ctx.client.writeProjectWorkspaceFile(projectId, fixture);
  }
  ctx.log(`[authoring:setup] seeded ${PAGE_FIXTURES.length} page fixtures`);
  await sendMeesterKickoff(ctx, projectId, FIND_VS_CREATE_KICKOFF_MESSAGE);
}

const TOTAL_CHECKS = 2;

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const projectId = await findProjectIdByName(ctx.client, PROJECT_NAME);
  if (!projectId) return { done: false };

  const authored = await authoredCraftbookSummaries(ctx.client, projectId);
  const { tasks } = await ctx.client.listProjectTasks(projectId);
  const bundledTask = (
    await findTaskForCraftbookAnywhere(ctx.client, projectId, BUNDLED_CRAFTBOOK_ID)
  )?.task;

  // Terminal verdict the moment the bundled-book task exists: success iff
  // the model got there WITHOUT authoring a book of its own. At most
  // first-gate progress is required — completion is never demanded.
  if (bundledTask) {
    if (authored.length === 0) {
      return {
        done: true,
        success: true,
        reason: `task ${bundledTask.ref} was sourced from the bundled "${BUNDLED_CRAFTBOOK_ID}" craftbook with no new local craftbook authored`,
      };
    }
    return {
      done: true,
      success: false,
      failureMode: 'success-check-false',
      reason: `task ${bundledTask.ref} uses "${BUNDLED_CRAFTBOOK_ID}" but the model also authored ${authored.length} new craftbook(s) (${authored.map((cb) => cb.id).join(', ')}) instead of relying on the library recipe alone`,
    };
  }

  const failures: string[] = [
    `no task sourced from the bundled "${BUNDLED_CRAFTBOOK_ID}" craftbook exists yet — search the recipe library for the page-metadata recipe and invoke it on this project`,
  ];
  if (authored.length > 0) {
    failures.push(
      `a new craftbook was authored (${authored.map((cb) => cb.id).join(', ')}) — the library already covers this; invoke the existing recipe instead`,
    );
  }

  return finishAuthoringPoll(ctx, {
    scenarioId: findVsCreateScenario.id,
    projectId,
    totalChecks: TOTAL_CHECKS,
    failures,
    bytes: progressBytes(JSON.stringify(tasks.map((task) => task.ref)), String(authored.length)),
    // No `deliverableMissing`: this is a SELECTION probe and it ends at task
    // creation, so there is no workspace file to be missing. Its `bytes` is
    // task metadata, which is the right progress proxy here.
    repairPath: 'craftbook selection',
    repairDirective: [
      'CRAFTBOOK_SELECTION_REPAIR: this brief is covered by an existing recipe in the library.',
      'Use the craftbook suggestion/listing tools to find the recipe about page metadata /',
      'search snippets / share cards and invoke it to create the task in this project. Do NOT',
      'author a new craftbook.',
    ].join(' '),
    successReason: 'selected and invoked the bundled recipe without authoring a new craftbook',
  });
}

export const findVsCreateScenario: EvalScenario = {
  id: 'craftbook-find-vs-create',
  description:
    'Selection probe: a brief paraphrasing the bundled seo-meta-pack domain must lead to ' +
    'invoking that library recipe (task sourced from the bundled id, zero locally authored ' +
    'books). Ends at task creation — completion is not demanded.',
  prompt: FIND_VS_CREATE_KICKOFF_MESSAGE,
  evidenceTexts: [FIND_VS_CREATE_KICKOFF_MESSAGE, FIND_VS_CREATE_MISSION_OBJECTIVES],
  suggestedTrials: 1,
  skipInitialPrompt: true,
  timeoutMs: 20 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  successCheck,
};
