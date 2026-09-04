import type { EvalContext, EvalScenario, SuccessCheckResult } from '../../types.ts';
import { findProjectIdByName, workspaceFromClient } from '../shared.ts';
import {
  ensureAuthoringProject,
  ensureAuthoringWorker,
  findTaskForCraftbook,
  finishAuthoringPoll,
  progressBytes,
  sendWorkerKickoff,
  unfinishedTaskFailure,
} from './helpers.ts';

/**
 * craftbook-edit-midtask — diagnose a live task stuck on an unwinnable
 * gate and repair its craftbook mid-flight.
 *
 * Axis: whole-document EDITING of an existing book. Setup seeds a
 * deliberately weak 2-step book through the format-NEUTRAL structured
 * create route (so seeding never exercises the codec under test), then
 * invokes it. The final step's gate demands a section heading the step
 * prompt never mentions, with onReject looped to itself — the task can
 * only complete after the model reads the task's craftbook (format-
 * exercised read), rewrites the failing step's prompt, and adds a
 * verification step (format-exercised write). Prompts stay format-blind.
 */

const PROJECT_NAME = 'Quarterly Brief';

export const SEEDED_CRAFTBOOK_ID = 'quarterly-brief-assembly';
export const NOTES_PATH = 'data/notes.txt';
export const SUMMARY_PATH = 'out/summary.md';

/** The heading the seeded gate demands but no prompt ever mentions. */
export const GATE_HEADING = '## Source Register';

export const SEEDED_DRAFT_PROMPT = `Read ${NOTES_PATH} and write a first draft of the quarterly brief to ${SUMMARY_PATH}. Cover the wins, the misses, and the numbers from the notes.`;

/** The weak final-step prompt — success requires this text to be rewritten. */
export const SEEDED_POLISH_PROMPT = `Give ${SUMMARY_PATH} a final polish: tighten the wording, fix any typos, and complete the step.`;

export const NOTES_TXT = `Q2 notes, raw dump (source: weekly standups + finance sheet)

Wins:
- Storefront relaunch shipped May 11, two weeks early.
- Wholesale channel signed 3 new stockists (Harbor Books, Casa Verde, Northside Gym).
- Support response time down from 26h to 9h after the macros rework.

Misses:
- The loyalty program slipped to Q3 (integration partner delayed).
- Two stockouts on SKU-330 in May cost an estimated 1.8k in orders.

Numbers:
- Revenue 148k (up 12% QoQ), gross margin 41%.
- Web sessions 210k, conversion 2.4%.
- Refund rate 1.1% (flat).
`;

export const EDIT_MIDTASK_MISSION_OBJECTIVES = [
  `Assemble the quarterly brief at ${SUMMARY_PATH} from ${NOTES_PATH} using the`,
  `"${SEEDED_CRAFTBOOK_ID}" recipe, and get its task all the way to completion.`,
  'If the recipe itself is defective — for example a step whose instructions do not match what',
  "its gate demands — repair the task's craftbook (fix the failing step's instructions and add",
  'a verification step) rather than fighting the gate blindly.',
].join(' ');

/** Kickoff template; `{ref}` is substituted with the live task ref in setup. */
export const EDIT_MIDTASK_KICKOFF_TEMPLATE = [
  'Task {ref} in this project keeps failing its final step gate — the crew rewrites the brief',
  'over and over and the gate rejects every attempt.',
  "Diagnose why: read the task's craftbook and compare each step's instructions against what",
  "its gate actually demands. Then FIX THE TASK'S CRAFTBOOK: rewrite the failing step's prompt",
  'so it instructs exactly what the gate demands, and add a verification step at the end of the',
  'recipe. Then drive the task to completion.',
  'The gate itself is correct — do not delete or weaken it.',
  "Make the fix with the craftbook editing tools (craftbook_read to inspect the task's book,",
  'then craftbook_write / craftbook_add_step to change it) — rewriting',
  'the output file over and over without fixing the recipe will keep failing.',
  'Do all of this on task {ref} in THIS project — do not create a new project or a replacement task.',
].join(' ');

/**
 * True while any step still carries the seeded weak prompt verbatim —
 * the "rewrote the failing step's prompt" milestone. Whitespace-trimmed
 * so codec round-trip framing doesn't matter. Exported for unit tests.
 */
export function seededPromptStillPresent(
  stepPrompts: ReadonlyArray<string | undefined>,
  seededPrompt: string = SEEDED_POLISH_PROMPT,
): boolean {
  const seeded = seededPrompt.trim();
  return stepPrompts.some((prompt) => (prompt ?? '').trim() === seeded);
}

async function setup(ctx: EvalContext): Promise<void> {
  const projectId = await ensureAuthoringProject(ctx, {
    name: PROJECT_NAME,
    about:
      'Assemble a quarterly brief from raw notes via a seeded (deliberately weak) craftbook; ' +
      'the recipe must be repaired mid-task before the brief can pass its gate.',
    missionObjectives: EDIT_MIDTASK_MISSION_OBJECTIVES,
  });
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: NOTES_PATH,
    content: NOTES_TXT,
  });

  // Seed the weak book through the STRUCTURED create route — format-
  // neutral on purpose. Only the model's later read/rewrite of the task's
  // craftbook exercises the document codec under test.
  await ctx.client.createCraftbook({
    id: SEEDED_CRAFTBOOK_ID,
    name: 'Quarterly Brief Assembly',
    description: 'Draft the quarterly brief from the raw notes, then polish and close it.',
    entryStepId: 'draft',
    steps: [
      {
        id: 'draft',
        name: 'Draft the brief',
        prompt: SEEDED_DRAFT_PROMPT,
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: SUMMARY_PATH, bytes: 80 }],
          onReject: 'draft',
        },
        next: 'polish',
      },
      {
        id: 'polish',
        name: 'Polish and close',
        prompt: SEEDED_POLISH_PROMPT,
        terminal: true,
        gate: {
          at: 'completion',
          checks: [
            { kind: 'minBytes', file: SUMMARY_PATH, bytes: 150 },
            {
              kind: 'contains',
              file: SUMMARY_PATH,
              pattern: GATE_HEADING,
              label: 'the brief carries the required section heading',
            },
          ],
          onReject: 'polish',
          maxAttempts: 8,
        },
      },
    ],
  });
  ctx.log(`[authoring:setup] seeded weak craftbook "${SEEDED_CRAFTBOOK_ID}"`);

  const task = await ctx.client.createTask(projectId, {
    title: 'Assemble the quarterly brief',
    description:
      'Assemble the quarterly brief from the raw notes and polish it until it passes its final gate.',
    craftbookId: SEEDED_CRAFTBOOK_ID,
    status: 'active',
    // Owned by the authoring worker — the same gezel the kickoff briefs,
    // so the diagnose → fix-the-craftbook → drive-to-completion loop is
    // one actor (the meester persona refuses direct craftbook surgery).
    assignee: { kind: 'gezel', gezelId: await ensureAuthoringWorker(ctx, 'Reza') },
  });
  ctx.log(`[authoring:setup] created task ${task.ref} from "${SEEDED_CRAFTBOOK_ID}"`);

  const workerId = await ensureAuthoringWorker(ctx, 'Reza');
  await sendWorkerKickoff(
    ctx,
    workerId,
    projectId,
    EDIT_MIDTASK_KICKOFF_TEMPLATE.replace('{ref}', task.ref),
  );
}

const TOTAL_CHECKS = 4;

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const projectId = await findProjectIdByName(ctx.client, PROJECT_NAME);
  if (!projectId) return { done: false };
  const task = await findTaskForCraftbook(ctx.client, projectId, SEEDED_CRAFTBOOK_ID);
  if (!task) return { done: false };

  const failures: string[] = [];
  const stepPrompts = task.craftbook.steps.map((step) => step.prompt);
  if (seededPromptStillPresent(stepPrompts)) {
    failures.push(
      `task ${task.ref} still carries the original failing step prompt verbatim — read the task's craftbook, find what the final gate demands, and rewrite that step's prompt to instruct it`,
    );
  }
  if (task.craftbook.steps.length < 3) {
    failures.push(
      `task ${task.ref}'s craftbook still has ${task.craftbook.steps.length} steps — add a verification step at the end of the recipe`,
    );
  }
  if (task.status !== 'complete') {
    failures.push(unfinishedTaskFailure({ ref: task.ref, status: task.status }));
  }

  const workspace = workspaceFromClient(ctx.client, projectId);
  const summaryText = await workspace.read(SUMMARY_PATH);

  return finishAuthoringPoll(ctx, {
    scenarioId: editMidtaskScenario.id,
    projectId,
    // The "task exists" milestone is implicitly passed once we get here.
    totalChecks: TOTAL_CHECKS,
    failures,
    // The step prompts are seeded content the scenario hands the model, so
    // counting them reported bytes before anything was produced. Only the
    // summary the model writes counts.
    bytes: progressBytes(summaryText),
    deliverableMissing: summaryText === null || summaryText.length === 0,
    repairPath: `task ${task.ref} craftbook`,
    repairDirective: [
      "CRAFTBOOK_MIDTASK_REPAIR: fix the FIRST failure above by editing the TASK'S craftbook",
      "(the live copy on the task, not just the catalog template): rewrite the failing step's",
      'prompt to instruct what its gate demands, add a terminal verification step, keep the',
      'gate itself intact, then execute the steps until the task completes.',
    ].join(' '),
    successReason:
      'diagnosed the unwinnable gate, rewrote the failing step prompt, grew the recipe with a verification step, and completed the task',
  });
}

export const editMidtaskScenario: EvalScenario = {
  id: 'craftbook-edit-midtask',
  description:
    'A seeded 2-step craftbook has a final gate demanding a section heading its prompt never ' +
    'mentions (onReject to itself). Diagnose the stuck task, rewrite the failing step prompt, ' +
    'add a verification step, and drive the task to completion.',
  prompt: EDIT_MIDTASK_KICKOFF_TEMPLATE,
  evidenceTexts: [EDIT_MIDTASK_KICKOFF_TEMPLATE, EDIT_MIDTASK_MISSION_OBJECTIVES],
  suggestedTrials: 1,
  skipInitialPrompt: true,
  timeoutMs: 45 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  successCheck,
};
