import type { EvalContext, EvalScenario, SuccessCheckResult } from '../../types.ts';
import { evaluateCraftbookGateChecks } from '../gates.ts';
import { findProjectIdByName, workspaceFromClient } from '../shared.ts';
import {
  AUTHORING_PROJECT_PIN,
  AUTHORING_TOOL_STEER,
  countCraftbookToolCalls,
  ensureAuthoringProject,
  ensureAuthoringWorker,
  findAuthoredCraftbook,
  findTaskForCraftbookAnywhere,
  finishAuthoringPoll,
  parseJsonRecords,
  progressBytes,
  sendWorkerKickoff,
  ungatedBuildStepIds,
} from './helpers.ts';

/**
 * craftbook-author-linear — author a reusable three-step craftbook from
 * scratch, then invoke it and run the resulting task to completion.
 *
 * Axis: single-document craftbook AUTHORING (the format A/B's anchor
 * cell). The generic craftbook scenarios all consume existing books; this
 * one grades whether a model can produce a well-formed book — every build
 * step gated with a file deliverable — through whichever whole-document
 * codec the daemon advertises (`GEZEL_CRAFTBOOK_DOC_FORMAT`). The prompt
 * is deliberately format-blind.
 */

const PROJECT_NAME = 'Order Intake Cleanup';
const BOOK_NAME_HINT = /order|cleanup|csv/i;

export const ORDERS_CSV_PATH = 'data/orders.csv';
export const ANOMALIES_PATH = 'notes/anomalies.md';
export const CLEAN_OUTPUT_PATH = 'out/orders.json';
export const REPORT_PATH = 'out/report.md';

/**
 * 30 order rows, 2 deliberately malformed: ORD-1013 has a spelled-out
 * quantity ("two"), ORD-1022 has an impossible date (2026-13-45). The
 * clean output should carry the valid rows — the grader requires ≥ 20
 * parsed records so either "drop" or "repair" handling passes.
 */
export const ORDERS_CSV = `order_id,customer,sku,qty,unit_price,order_date
ORD-1001,Brightwater Cafe,SKU-201,4,12.50,2026-05-02
ORD-1002,Harbor Books,SKU-118,2,34.00,2026-05-02
ORD-1003,Linden Florists,SKU-330,10,3.75,2026-05-03
ORD-1004,Casa Verde,SKU-201,1,12.50,2026-05-03
ORD-1005,Northside Gym,SKU-442,6,18.20,2026-05-04
ORD-1006,Brightwater Cafe,SKU-118,3,34.00,2026-05-05
ORD-1007,Pixel & Frame,SKU-509,2,55.00,2026-05-05
ORD-1008,Harbor Books,SKU-330,12,3.75,2026-05-06
ORD-1009,Milo's Deli,SKU-201,5,12.50,2026-05-06
ORD-1010,Casa Verde,SKU-442,2,18.20,2026-05-07
ORD-1011,Linden Florists,SKU-509,1,55.00,2026-05-08
ORD-1012,Northside Gym,SKU-118,4,34.00,2026-05-08
ORD-1013,Pixel & Frame,SKU-330,two,3.75,2026-05-09
ORD-1014,Milo's Deli,SKU-442,8,18.20,2026-05-09
ORD-1015,Brightwater Cafe,SKU-509,2,55.00,2026-05-10
ORD-1016,Harbor Books,SKU-201,7,12.50,2026-05-11
ORD-1017,Casa Verde,SKU-118,1,34.00,2026-05-11
ORD-1018,Linden Florists,SKU-442,3,18.20,2026-05-12
ORD-1019,Northside Gym,SKU-330,15,3.75,2026-05-12
ORD-1020,Pixel & Frame,SKU-201,2,12.50,2026-05-13
ORD-1021,Milo's Deli,SKU-509,1,55.00,2026-05-14
ORD-1022,Brightwater Cafe,SKU-442,5,18.20,2026-13-45
ORD-1023,Harbor Books,SKU-509,3,55.00,2026-05-15
ORD-1024,Casa Verde,SKU-330,9,3.75,2026-05-15
ORD-1025,Linden Florists,SKU-201,6,12.50,2026-05-16
ORD-1026,Northside Gym,SKU-509,2,55.00,2026-05-17
ORD-1027,Pixel & Frame,SKU-118,4,34.00,2026-05-17
ORD-1028,Milo's Deli,SKU-330,11,3.75,2026-05-18
ORD-1029,Brightwater Cafe,SKU-201,3,12.50,2026-05-19
ORD-1030,Harbor Books,SKU-442,7,18.20,2026-05-19
`;

export const AUTHOR_LINEAR_MISSION_OBJECTIVES = [
  'Author a reusable craftbook named "CSV Order Cleanup" that turns a raw order export into',
  'clean structured records, then run it here until the outputs exist.',
  'The craftbook needs three steps: (1) inspect the raw data and record anomalies in',
  `${ANOMALIES_PATH}; (2) clean the data into ${CLEAN_OUTPUT_PATH} (an array of order records);`,
  `(3) verify the results and write ${REPORT_PATH}.`,
  'Every build step must declare its file deliverable so the runtime can hold the step until',
  'the file really exists.',
  'The eval only passes when the craftbook exists as a reusable template, a task created from',
  `it has run to completion, and ${ANOMALIES_PATH}, ${CLEAN_OUTPUT_PATH}, and ${REPORT_PATH}`,
  'all exist in this project workspace.',
].join(' ');

export const AUTHOR_LINEAR_KICKOFF_MESSAGE = [
  `We keep getting messy order exports like ${ORDERS_CSV_PATH} (30 rows; a couple of them are`,
  'malformed). I want a repeatable recipe for this, not a one-off fix.',
  'Please AUTHOR a reusable craftbook named "CSV Order Cleanup" with exactly this shape:',
  `step 1 "inspect" reads the raw export and writes the anomalies it finds to ${ANOMALIES_PATH};`,
  `step 2 "clean" writes the cleaned records to ${CLEAN_OUTPUT_PATH} as an array of order`,
  'records (keep the valid rows — at least 20 records must survive);',
  `step 3 "verify" checks the cleaned output and writes a short findings report to ${REPORT_PATH}.`,
  'Every build step must declare its file deliverable (the exact output path above) so the step',
  'is gated on the file actually existing.',
  'Once the craftbook is saved as a reusable template, invoke it on this project and drive the',
  'resulting task all the way to completion — do not stop after authoring.',
  'All paths are workspace-root-relative; write outputs with workspace file tools.',
  AUTHORING_TOOL_STEER,
  AUTHORING_PROJECT_PIN,
].join(' ');

async function setup(ctx: EvalContext): Promise<void> {
  const projectId = await ensureAuthoringProject(ctx, {
    name: PROJECT_NAME,
    about:
      'Turn a messy raw order export into clean structured records via a reusable craftbook: ' +
      'inspect for anomalies, clean into structured output, verify with a findings report.',
    missionObjectives: AUTHOR_LINEAR_MISSION_OBJECTIVES,
  });
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: ORDERS_CSV_PATH,
    content: ORDERS_CSV,
  });
  ctx.log(`[authoring:setup] seeded ${ORDERS_CSV_PATH} (30 rows, 2 malformed)`);
  // Kick off the AUTHORING WORKER directly (not the meester): the meester
  // persona refuses direct authorship — see AUTHORING_WORKER_ABOUT.
  const workerId = await ensureAuthoringWorker(ctx, 'Reza');
  await sendWorkerKickoff(ctx, workerId, projectId, AUTHOR_LINEAR_KICKOFF_MESSAGE);
}

const TOTAL_CHECKS = 7;

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const projectId = await findProjectIdByName(ctx.client, PROJECT_NAME);
  if (!projectId) return { done: false };

  const failures: string[] = [];
  const book = await findAuthoredCraftbook(ctx.client, {
    projectId,
    minSteps: 3,
    nameHint: BOOK_NAME_HINT,
  });
  // Grade the workspace where the craftbook's task actually ran — the
  // prompt pins the seeded project, but a detour must not zero out real
  // authored work (the outputs land wherever the task lives).
  let gradeProjectId = projectId;
  if (!book) {
    failures.push(
      'no reusable authored craftbook with at least 3 steps exists yet — author "CSV Order Cleanup" (inspect, clean, verify) as a craftbook template, not as ad-hoc chat work',
    );
  } else {
    const ungated = ungatedBuildStepIds(book.craftbook.steps);
    if (ungated.length > 0) {
      failures.push(
        `craftbook "${book.craftbook.id}" has build steps without a gate or file deliverable: ${ungated.join(', ')} — declare each step's output file as its deliverable`,
      );
    }
    const found = await findTaskForCraftbookAnywhere(ctx.client, projectId, book.craftbook.id);
    if (!found) {
      failures.push(
        `no task has been created from craftbook "${book.craftbook.id}" yet — invoke the craftbook on this project`,
      );
    } else {
      gradeProjectId = found.projectId;
      if (found.task.status !== 'complete') {
        failures.push(
          `task ${found.task.ref} (from craftbook "${book.craftbook.id}") has status "${found.task.status}" — drive it to completion`,
        );
      }
    }
  }

  const workspace = workspaceFromClient(ctx.client, gradeProjectId);
  const gateResult = await evaluateCraftbookGateChecks(
    [
      { kind: 'minBytes', file: ANOMALIES_PATH, bytes: 80 },
      { kind: 'minBytes', file: REPORT_PATH, bytes: 80 },
    ],
    workspace,
  );
  failures.push(...gateResult.failures);
  const cleanText = await workspace.read(CLEAN_OUTPUT_PATH);
  const parsed = parseJsonRecords(cleanText, CLEAN_OUTPUT_PATH, 20);
  if (!parsed.ok) failures.push(parsed.reason);

  return finishAuthoringPoll(ctx, {
    scenarioId: authorLinearScenario.id,
    projectId,
    totalChecks: TOTAL_CHECKS,
    failures,
    bytes:
      progressBytes(
        cleanText,
        await workspace.read(ANOMALIES_PATH),
        await workspace.read(REPORT_PATH),
        book ? JSON.stringify(book.craftbook.steps.map((step) => step.id)) : null,
      ) +
      500 * (await countCraftbookToolCalls(ctx, projectId)),
    repairPath: 'craftbook: CSV Order Cleanup',
    repairDirective: [
      'CRAFTBOOK_AUTHORING_REPAIR: this eval grades the craftbook catalog and the task graph,',
      'not a chat summary. Fix the FIRST failure above using craftbook/task tools:',
      'author or amend the reusable "CSV Order Cleanup" craftbook (three steps, each build step',
      'declaring its output file as a deliverable), invoke it on this project, then execute the',
      'active step(s) until the task is complete and all three output files exist.',
    ].join(' '),
    successReason:
      'authored a gated 3-step craftbook, invoked it, ran the task to completion, and all three outputs pass their checks',
  });
}

export const authorLinearScenario: EvalScenario = {
  id: 'craftbook-author-linear',
  description:
    'Author a reusable 3-step craftbook (inspect → clean → verify, every build step gated by a ' +
    'file deliverable) from one messy CSV fixture, invoke it, and run the task to completion.',
  prompt: AUTHOR_LINEAR_KICKOFF_MESSAGE,
  evidenceTexts: [AUTHOR_LINEAR_KICKOFF_MESSAGE, AUTHOR_LINEAR_MISSION_OBJECTIVES],
  suggestedTrials: 1,
  skipInitialPrompt: true,
  timeoutMs: 45 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  successCheck,
};
