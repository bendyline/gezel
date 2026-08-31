import type { EvalContext, EvalScenario, SuccessCheckResult } from '../../types.ts';
import { findProjectIdByName } from '../shared.ts';
import {
  AUTHORING_PROJECT_PIN,
  authoredCraftbookSummaries,
  countCraftbookToolCalls,
  ensureAuthoringProject,
  findTaskForCraftbookAnywhere,
  finishAuthoringPoll,
  progressBytes,
  sendMeesterKickoff,
} from './helpers.ts';

/**
 * dev-craftbook-routing — the ENGINEERING selection probe: given a plain
 * developer brief, reach for the one library recipe that matches, out of
 * three that all look plausible.
 *
 * Axis: craftbook routing under near-neighbour ambiguity, in the domain
 * the `developer` suite measures. `craftbook-find-vs-create` asks the
 * easier question (find something vs. author something); here a book is
 * definitely right and two others are definitely wrong, and they overlap
 * hard — `bug-fix-tdd` and `root-cause-investigation` ship the *identical*
 * trigger phrase "fix this bug".
 *
 * The brief settles it for anyone who reads it: the defect is already
 * located and explained (so there is nothing to root-cause), nothing is on
 * fire (so it is not a hotfix), and the ask is explicitly for a test that
 * fails before it passes. Reflex-matching on the word "bug" picks wrong.
 * That gap between reflex and reading IS the measurement, so the brief
 * never names a recipe, a step, or a piece of book vocabulary.
 *
 * Terminal at task creation, like `find-vs-create`: completion is never
 * demanded, which caps the cost of a selection probe.
 */

const PROJECT_NAME = 'Batch Exporter';

/** The only correct route. */
export const CORRECT_CRAFTBOOK_ID = 'bug-fix-tdd';

/**
 * Plausible-but-wrong routes. Choosing one is a terminal failure, not a
 * "keep polling" — a confidently wrong recipe is the failure this probe
 * exists to catch, and letting the trial run on would grade patience.
 */
export const DECOY_CRAFTBOOK_IDS = ['root-cause-investigation', 'hotfix-flow'] as const;

export const BATCHES_TS_PATH = 'src/batches.ts';
export const BATCHES_TEST_PATH = 'tests/batches.test.ts';

/**
 * The seeded defect, deliberately obvious: the slice end is inclusive, so
 * every batch after the first repeats its predecessor's last item. The
 * shipped test only covers a total that divides evenly by the batch size,
 * which is why the suite is green and the bug reached customers.
 */
export const BATCHES_TS = `export interface ExportItem {
  id: string;
  label: string;
}

export function splitIntoBatches(items: ExportItem[], batchSize: number): ExportItem[][] {
  if (batchSize < 1) throw new Error('batchSize must be at least 1');
  const batches: ExportItem[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize + 1));
  }
  return batches;
}
`;

export const BATCHES_TEST_TS = `import { describe, expect, it } from 'vitest';
import { splitIntoBatches } from '../src/batches.js';

const items = Array.from({ length: 4 }, (_, index) => ({
  id: String(index),
  label: 'item-' + index,
}));

describe('splitIntoBatches', () => {
  it('returns one batch when everything fits', () => {
    expect(splitIntoBatches(items, 4)).toHaveLength(1);
  });
});
`;

export const ROUTE_DEV_MISSION_OBJECTIVES = [
  `The export batching helper in ${BATCHES_TS_PATH} repeats an item at every batch boundary.`,
  'The cause is already understood and written down below — nobody needs to go hunting for it,',
  'and nothing is broken in production right now.',
  'Set this up as a task in this project. Check the recipe library for an existing craftbook',
  'that fits the way we want this handled, and use that one — do not author a new recipe when',
  'the library already has one, and do not start editing the file by hand.',
].join(' ');

export const ROUTE_DEV_KICKOFF_MESSAGE = [
  `A customer noticed our CSV export repeats rows. I traced it already: in ${BATCHES_TS_PATH},`,
  'splitIntoBatches slices one element too far, so every batch after the first starts with a',
  "copy of the previous batch's last item. I know exactly where it is and why it happens, so",
  "there's nothing left to investigate.",
  'This is also not on fire — the export is a weekly job, nobody is paged, and we can take our',
  'time and do it properly rather than patching it out of band.',
  'What I actually care about is that it never comes back. Our existing test only checks a',
  'total that divides evenly by the batch size, which is precisely why this shipped. So I want',
  'a test that fails on the current code first, and only then the fix that turns it green.',
  'Please set this up as a task in this project: look through the recipe library, pick the one',
  'that matches how I have just asked for this to be handled, and start the task from it.',
  'Do not author a new recipe, and do not start editing the source yourself.',
  AUTHORING_PROJECT_PIN,
].join(' ');

async function setup(ctx: EvalContext): Promise<void> {
  const projectId = await ensureAuthoringProject(ctx, {
    name: PROJECT_NAME,
    about:
      'A small export service. Its batching helper repeats an item at every batch boundary; ' +
      'the cause is known and the team wants a regression test that fails first, then the fix.',
    missionObjectives: ROUTE_DEV_MISSION_OBJECTIVES,
  });
  for (const fixture of [
    { path: BATCHES_TS_PATH, content: BATCHES_TS },
    { path: BATCHES_TEST_PATH, content: BATCHES_TEST_TS },
  ]) {
    await ctx.client.writeProjectWorkspaceFile(projectId, fixture);
  }
  ctx.log('[authoring:setup] seeded the batching helper and its (green, insufficient) test');
  await sendMeesterKickoff(ctx, projectId, ROUTE_DEV_KICKOFF_MESSAGE);
}

const TOTAL_CHECKS = 2;

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const projectId = await findProjectIdByName(ctx.client, PROJECT_NAME);
  if (!projectId) return { done: false };

  const authored = await authoredCraftbookSummaries(ctx.client, projectId);
  const correct = await findTaskForCraftbookAnywhere(ctx.client, projectId, CORRECT_CRAFTBOOK_ID);

  // The correct route wins the moment it exists, even if a decoy task was
  // created first: a model that reconsiders and lands on the right recipe
  // has demonstrated the capability under test.
  if (correct) {
    if (authored.length === 0) {
      return {
        done: true,
        success: true,
        reason: `task ${correct.task.ref} was started from the bundled "${CORRECT_CRAFTBOOK_ID}" recipe with no new craftbook authored`,
      };
    }
    return {
      done: true,
      success: false,
      failureMode: 'success-check-false',
      reason: `task ${correct.task.ref} uses "${CORRECT_CRAFTBOOK_ID}" but ${authored.length} new craftbook(s) were also authored (${authored.map((cb) => cb.id).join(', ')}) — the library recipe was enough`,
    };
  }

  for (const decoyId of DECOY_CRAFTBOOK_IDS) {
    const decoy = await findTaskForCraftbookAnywhere(ctx.client, projectId, decoyId);
    if (!decoy) continue;
    return {
      done: true,
      success: false,
      failureMode: 'success-check-false',
      reason: `task ${decoy.task.ref} was started from "${decoyId}" — the brief states the cause is already known and nothing is on fire, and asks for a test that fails before the fix, which is a different recipe`,
    };
  }

  const { tasks } = await ctx.client.listProjectTasks(projectId);
  const failures: string[] = [
    'no task has been started from a library recipe yet — search the recipe library for the one that matches this brief (the cause is known, nothing is urgent, and a failing test is wanted before the fix) and start the task from it',
  ];
  if (authored.length > 0) {
    failures.push(
      `a new craftbook was authored (${authored.map((cb) => cb.id).join(', ')}) — the library already covers this; use the existing recipe instead`,
    );
  }

  return finishAuthoringPoll(ctx, {
    scenarioId: devCraftbookRoutingScenario.id,
    projectId,
    totalChecks: TOTAL_CHECKS,
    failures,
    bytes:
      progressBytes(JSON.stringify(tasks.map((task) => task.ref)), String(authored.length)) +
      500 * (await countCraftbookToolCalls(ctx, projectId)),
    repairPath: 'craftbook selection (engineering)',
    repairDirective: [
      'CRAFTBOOK_SELECTION_REPAIR: this brief is covered by an existing recipe in the library.',
      'Call suggest_craftbook with a short description of the job, read the candidates, and',
      'pick the one that matches what was actually asked for — re-read the brief for whether',
      'the cause is already known, whether it is urgent, and what proof is wanted. Then call',
      'invoke_craftbook on that recipe to create the task. Do NOT author a new craftbook and do',
      'NOT edit the source by hand.',
    ].join(' '),
    successReason: 'selected and invoked the matching library recipe without authoring a new one',
  });
}

export const devCraftbookRoutingScenario: EvalScenario = {
  id: 'dev-craftbook-routing',
  description:
    'Engineering selection probe under near-neighbour ambiguity: a plain bug brief that rules ' +
    'out investigation (cause known) and hotfix (not urgent) and asks for a failing test ' +
    'before the fix must route to bug-fix-tdd. Starting a task from root-cause-investigation ' +
    'or hotfix-flow is a terminal failure. Ends at task creation.',
  prompt: ROUTE_DEV_KICKOFF_MESSAGE,
  evidenceTexts: [ROUTE_DEV_KICKOFF_MESSAGE, ROUTE_DEV_MISSION_OBJECTIVES],
  suggestedTrials: 1,
  skipInitialPrompt: true,
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  successCheck,
};
