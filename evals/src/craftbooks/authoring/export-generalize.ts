import type { EvalContext, EvalScenario, SuccessCheckResult } from '../../types.ts';
import { findProjectIdByName, workspaceFromClient } from '../shared.ts';
import {
  AUTHORING_PROJECT_PIN,
  AUTHORING_TOOL_STEER,
  ensureAuthoringProject,
  ensureAuthoringWorker,
  findAuthoredCraftbook,
  findTaskForCraftbookAnywhere,
  finishAuthoringPoll,
  noDeliverableWritten,
  parseJsonRecords,
  progressBytes,
  sendWorkerKickoff,
  unfinishedTaskFailure,
} from './helpers.ts';

/**
 * craftbook-export-generalize — do the job once concretely, then turn
 * that one-off pass into a reusable recipe and re-run it on a second,
 * different input.
 *
 * Axis: GENERALIZATION — the recurrence pitch the whole craftbook system
 * rests on. Every other authoring scenario asks for a recipe up front, so
 * the model never has to separate the procedure from the first dataset it
 * happened to run on. Here the Q1 pass is deliberately hand-done first;
 * the measured act is recognizing which parts of it were incidental to Q1
 * (names, countries, which two rows were bad) and which are the actual
 * repeatable steps, then proving the recipe generalizes by producing Q2's
 * outputs THROUGH it.
 *
 * The grader deliberately does NOT care which route saved the recipe
 * (`export_task_craftbook` promoting the finished task, or a hand-authored
 * `craftbook_write`). Both are correct product behavior; gating on the
 * tool name would measure route preference instead of generalization.
 * Prompt stays format-blind about the craftbook document codec.
 */

const PROJECT_NAME = 'Supplier Intake';
const BOOK_NAME_HINT = /supplier|intake|quarter/i;

export const SUPPLIERS_Q1_PATH = 'data/suppliers-q1.json';
export const SUPPLIERS_Q2_PATH = 'data/suppliers-q2.json';
export const Q1_REPORT_PATH = 'out/q1-intake.md';
export const Q1_CLEAN_PATH = 'out/q1-clean.json';
export const Q2_REPORT_PATH = 'out/q2-intake.md';
export const Q2_CLEAN_PATH = 'out/q2-clean.json';

const MIN_REPORT_CHARS = 80;
/**
 * 8 suppliers minus the 2 impossible lead times = 6, so a run that DROPS
 * the bad records clears the floor exactly as a run that REPAIRS them
 * does. The grader must not prefer one cleaning policy over the other.
 */
const MIN_CLEAN_RECORDS = 5;

/** Two impossible lead times (0 and -5) so the Q1 pass has real work in it. */
export const SUPPLIERS_Q1_JSON = `${JSON.stringify(
  [
    {
      name: 'Kettle & Vane Ceramics',
      contact: 'ops@kettlevane.example',
      country: 'NL',
      leadTimeDays: 12,
      minOrderValue: 250,
    },
    {
      name: 'Bramble Paper Works',
      contact: 'orders@bramblepaper.example',
      country: 'GB',
      leadTimeDays: 18,
      minOrderValue: 400,
    },
    {
      name: 'Norrland Textiles',
      contact: 'sales@norrlandtextiles.example',
      country: 'SE',
      leadTimeDays: 0,
      minOrderValue: 300,
    },
    {
      name: 'Casa Olivo Glass',
      contact: 'contacto@casaolivo.example',
      country: 'ES',
      leadTimeDays: 21,
      minOrderValue: 600,
    },
    {
      name: 'Vermeer Beeswax',
      contact: 'info@vermeerbeeswax.example',
      country: 'BE',
      leadTimeDays: 9,
      minOrderValue: 180,
    },
    {
      name: 'Alpine Cork Supply',
      contact: 'kontakt@alpinecork.example',
      country: 'AT',
      leadTimeDays: -5,
      minOrderValue: 220,
    },
    {
      name: 'Ravenna Brass',
      contact: 'ordini@ravennabrass.example',
      country: 'IT',
      leadTimeDays: 15,
      minOrderValue: 500,
    },
    {
      name: 'Suomi Birch Goods',
      contact: 'myynti@suomibirch.example',
      country: 'FI',
      leadTimeDays: 27,
      minOrderValue: 350,
    },
  ],
  null,
  2,
)}\n`;

/**
 * Same shape, entirely different suppliers and countries, and its two
 * impossible lead times sit at different list positions than Q1's — so a
 * recipe that hardcoded "rows 3 and 6 are the bad ones" from the Q1 pass
 * produces a visibly wrong Q2 report. Nothing about Q1 transfers except
 * the procedure itself.
 */
export const SUPPLIERS_Q2_JSON = `${JSON.stringify(
  [
    {
      name: 'Douro Tile Studio',
      contact: 'geral@dourotile.example',
      country: 'PT',
      leadTimeDays: 16,
      minOrderValue: 480,
    },
    {
      name: 'Trollhaugen Wool',
      contact: 'post@trollhaugenwool.example',
      country: 'NO',
      leadTimeDays: 0,
      minOrderValue: 260,
    },
    {
      name: 'Gdansk Amber Co',
      contact: 'biuro@gdanskamber.example',
      country: 'PL',
      leadTimeDays: 24,
      minOrderValue: 300,
    },
    {
      name: 'Bosphorus Copperworks',
      contact: 'siparis@bosphoruscopper.example',
      country: 'TR',
      leadTimeDays: 19,
      minOrderValue: 520,
    },
    {
      name: 'Loire Linen House',
      contact: 'bonjour@loirelinen.example',
      country: 'FR',
      leadTimeDays: 11,
      minOrderValue: 340,
    },
    {
      name: 'Aegean Olivewood',
      contact: 'sales@aegeanolivewood.example',
      country: 'GR',
      leadTimeDays: 22,
      minOrderValue: 410,
    },
    {
      name: 'Zagreb Enamel',
      contact: 'narudzbe@zagrebenamel.example',
      country: 'HR',
      leadTimeDays: -14,
      minOrderValue: 190,
    },
    {
      name: 'Riga Glassworks',
      contact: 'pasutijumi@rigaglass.example',
      country: 'LV',
      leadTimeDays: 8,
      minOrderValue: 275,
    },
  ],
  null,
  2,
)}\n`;

export const EXPORT_GENERALIZE_MISSION_OBJECTIVES = [
  'Work the Q1 supplier list by hand first: flag the suppliers whose lead time is impossible and',
  `produce ${Q1_REPORT_PATH} plus the cleaned records at ${Q1_CLEAN_PATH}.`,
  'Then generalize that one-off pass into a reusable recipe saved in the library, and run that',
  `recipe over the Q2 list to produce ${Q2_REPORT_PATH} and ${Q2_CLEAN_PATH}.`,
  'The second quarter must be produced by running the saved recipe, not by repeating the work by',
  "hand and not by copying Q1's outputs across.",
  'The eval only passes when all four outputs exist, the Q2 outputs genuinely differ from the Q1',
  'outputs, the reusable recipe exists as a saved template, and the task created from it has run',
  'to completion.',
].join(' ');

export const EXPORT_GENERALIZE_KICKOFF_MESSAGE = [
  `Our Q1 supplier list just landed at ${SUPPLIERS_Q1_PATH} — eight suppliers.`,
  'Please check it over: a couple of the lead times are impossible and I want those called out.',
  `Write me a short intake report at ${Q1_REPORT_PATH} saying what you checked and what is wrong,`,
  `and put the cleaned-up supplier records at ${Q1_CLEAN_PATH} — one flat list, one entry per`,
  'supplier.',
  'Now the half that actually matters to me: we get one of these every quarter, and I do not want',
  'to ask for it from scratch again. Once Q1 is done, do NOT stop — turn what you just did into a',
  'reusable recipe and save it in the library so next quarter costs one call.',
  "Two steps is plenty for the recipe: check a quarter's list and flag the impossible lead",
  "times, then write that quarter's intake report and its cleaned records.",
  `Then show me it works: run that recipe over ${SUPPLIERS_Q2_PATH} — the Q2 list, different`,
  `suppliers, same kind of file — to produce ${Q2_REPORT_PATH} and ${Q2_CLEAN_PATH}.`,
  'The Q2 outputs have to come out of the recipe running over the Q2 list. Do not hand-write them',
  'and do not copy the Q1 outputs across.',
  'You have two ways to save the recipe: export_task_craftbook promotes work you already ran as a',
  'task into a reusable recipe, and craftbook_write saves one you author yourself. Either is fine',
  '— pick whichever fits how you did Q1. export_task_craftbook only applies if the Q1 pass ran as',
  'a task; if you did Q1 straight from this chat, or that tool is not in your kit, author the',
  'recipe with craftbook_write instead and do not keep retrying the other one.',
  AUTHORING_TOOL_STEER,
  'One amendment to that last note: the Q1 pass IS meant to be done by hand first — that is the',
  'whole point of this job. The rule that nothing may be produced by hand applies from Q2 onward,',
  'which must come out of the saved recipe.',
  'All paths are workspace-root-relative; write outputs with workspace file tools.',
  AUTHORING_PROJECT_PIN,
].join(' ');

async function setup(ctx: EvalContext): Promise<void> {
  const projectId = await ensureAuthoringProject(ctx, {
    name: PROJECT_NAME,
    about:
      'Quarterly supplier lists arrive as a raw export. Each quarter needs the impossible lead ' +
      'times flagged, a short intake report, and a cleaned record set — the same procedure every ' +
      'time, which is why it should end up as a reusable recipe rather than repeated by hand.',
    missionObjectives: EXPORT_GENERALIZE_MISSION_OBJECTIVES,
  });
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: SUPPLIERS_Q1_PATH,
    content: SUPPLIERS_Q1_JSON,
  });
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: SUPPLIERS_Q2_PATH,
    content: SUPPLIERS_Q2_JSON,
  });
  ctx.log(
    `[authoring:setup] seeded ${SUPPLIERS_Q1_PATH} and ${SUPPLIERS_Q2_PATH} (8 suppliers each, 2 impossible lead times each)`,
  );
  const workerId = await ensureAuthoringWorker(ctx, 'Reza');
  await sendWorkerKickoff(ctx, workerId, projectId, EXPORT_GENERALIZE_KICKOFF_MESSAGE);
}

function reportFailure(text: string | null, path: string, hint: string): string | null {
  if (text === null) return `${path} does not exist yet — ${hint}`;
  const trimmed = text.trim();
  if (trimmed.length < MIN_REPORT_CHARS) {
    return `${path} is only ${trimmed.length} characters — ${hint}`;
  }
  return null;
}

/**
 * The copy-across detector. Callers gate it on both sides having passed
 * their own checks: a missing, short, or unparseable Q2 file already has
 * a more actionable failure, and reporting both would double-count one
 * deliverable against `TOTAL_CHECKS`.
 */
function copiedFailure(
  first: string | null,
  second: string | null,
  firstPath: string,
  secondPath: string,
): string | null {
  if (first === null || second === null) return null;
  if (first.trim() !== second.trim()) return null;
  return `${secondPath} is identical to ${firstPath} — the Q2 outputs must be produced by running the saved recipe over ${SUPPLIERS_Q2_PATH}, not copied from Q1`;
}

const TOTAL_CHECKS = 6;

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const projectId = await findProjectIdByName(ctx.client, PROJECT_NAME);
  if (!projectId) return { done: false };

  const craftbookFailures: string[] = [];
  const book = await findAuthoredCraftbook(ctx.client, {
    projectId,
    minSteps: 2,
    nameHint: BOOK_NAME_HINT,
  });
  // Grade the workspace where the recipe's task actually ran — the prompt
  // pins the seeded project, but a detour must not zero out real work.
  let gradeProjectId = projectId;
  if (!book) {
    craftbookFailures.push(
      'no reusable authored craftbook with at least 2 steps exists yet — generalize the Q1 pass into a saved reusable recipe (export the finished task with export_task_craftbook, or author it with craftbook_write)',
    );
  } else {
    const found = await findTaskForCraftbookAnywhere(ctx.client, projectId, book.craftbook.id);
    if (!found) {
      craftbookFailures.push(
        `no task has been created from craftbook "${book.craftbook.id}" yet — invoke it on this project so the Q2 pass is produced BY the recipe`,
      );
    } else {
      gradeProjectId = found.projectId;
      if (found.task.status !== 'complete') {
        craftbookFailures.push(
          unfinishedTaskFailure({
            ref: found.task.ref,
            status: found.task.status,
            source: `from craftbook "${book.craftbook.id}"`,
          }),
        );
      }
    }
  }

  const graded = workspaceFromClient(ctx.client, gradeProjectId);
  // The Q1 pass happens BEFORE the recipe's task exists, so on a detour it
  // legitimately sits in the pinned project while the task lives elsewhere.
  const pinned = gradeProjectId === projectId ? graded : workspaceFromClient(ctx.client, projectId);
  const readOutput = async (path: string): Promise<string | null> =>
    (await graded.read(path)) ?? (await pinned.read(path));

  const q1Report = await readOutput(Q1_REPORT_PATH);
  const q1Clean = await readOutput(Q1_CLEAN_PATH);
  const q2Report = await readOutput(Q2_REPORT_PATH);
  const q2Clean = await readOutput(Q2_CLEAN_PATH);

  const q1Failures: string[] = [];
  const q1ReportFailure = reportFailure(
    q1Report,
    Q1_REPORT_PATH,
    'write the short Q1 intake report there: what you checked and which suppliers have an impossible lead time',
  );
  if (q1ReportFailure) q1Failures.push(q1ReportFailure);
  const q1Parsed = parseJsonRecords(q1Clean, Q1_CLEAN_PATH, MIN_CLEAN_RECORDS);
  if (!q1Parsed.ok) {
    q1Failures.push(
      `${q1Parsed.reason} — write the cleaned Q1 supplier records there as one list of supplier entries`,
    );
  }

  const q2Failures: string[] = [];
  const q2ReportFailure = reportFailure(
    q2Report,
    Q2_REPORT_PATH,
    `write the Q2 intake report there by running the saved recipe over ${SUPPLIERS_Q2_PATH}`,
  );
  if (q2ReportFailure) q2Failures.push(q2ReportFailure);
  const q2Parsed = parseJsonRecords(q2Clean, Q2_CLEAN_PATH, MIN_CLEAN_RECORDS);
  if (!q2Parsed.ok) {
    q2Failures.push(
      `${q2Parsed.reason} — the cleaned Q2 supplier records are the recipe's second deliverable`,
    );
  }

  // Each deliverable contributes at most ONE failure: the copy check only
  // runs once that pair cleared its own checks. Without the guard a pair of
  // short, identical files books three failures for one file, which pushes
  // the total past TOTAL_CHECKS (score floors at 0 while real work exists)
  // and buries the actionable "write more than 80 characters" line under a
  // copy complaint the model cannot act on yet.
  const copyFailures: string[] = [];
  if (q1Parsed.ok && q2Parsed.ok) {
    const copiedClean = copiedFailure(q1Clean, q2Clean, Q1_CLEAN_PATH, Q2_CLEAN_PATH);
    if (copiedClean) copyFailures.push(copiedClean);
  }
  if (!q1ReportFailure && !q2ReportFailure) {
    const copiedReport = copiedFailure(q1Report, q2Report, Q1_REPORT_PATH, Q2_REPORT_PATH);
    if (copiedReport) copyFailures.push(copiedReport);
  }

  // Ordered in the natural work order so the repair nudge always points at
  // the next thing to do rather than dragging the model back to authoring
  // while the Q1 pass it is supposed to generalize is still unfinished.
  const failures = [...q1Failures, ...craftbookFailures, ...q2Failures, ...copyFailures];

  return finishAuthoringPoll(ctx, {
    scenarioId: exportGeneralizeScenario.id,
    projectId,
    totalChecks: TOTAL_CHECKS,
    failures,
    bytes: progressBytes(
      q1Report,
      q1Clean,
      q2Report,
      q2Clean,
      book ? JSON.stringify(book.craftbook.steps.map((step) => step.id)) : null,
    ),
    deliverableMissing: noDeliverableWritten(q1Report, q1Clean, q2Report, q2Clean),
    repairPath: 'craftbook: supplier intake recipe',
    repairDirective: [
      'CRAFTBOOK_GENERALIZE_REPAIR: this eval grades the craftbook catalog, the task graph, and',
      'four output files — not a chat summary. Fix the FIRST failure above.',
      'The shape of the job: finish the Q1 pass, save that pass as a reusable craftbook (export',
      'the finished task with export_task_craftbook, or author it with craftbook_write), invoke',
      'that craftbook on this project, and let it produce the Q2 outputs from the Q2 list — the',
      'Q2 files must not be copies of the Q1 files.',
    ].join(' '),
    successReason:
      'did the Q1 pass, generalized it into a saved reusable craftbook, ran that craftbook to completion, and the Q2 outputs are genuinely derived from the Q2 list',
  });
}

export const exportGeneralizeScenario: EvalScenario = {
  id: 'craftbook-export-generalize',
  description:
    'Do a supplier-list intake once by hand, then generalize that one-off pass into a reusable ' +
    'craftbook (exported from the finished task or authored directly), invoke it on a second ' +
    "quarter's list, and grade that the second quarter's outputs are genuinely derived rather " +
    'than copied.',
  prompt: EXPORT_GENERALIZE_KICKOFF_MESSAGE,
  evidenceTexts: [EXPORT_GENERALIZE_KICKOFF_MESSAGE, EXPORT_GENERALIZE_MISSION_OBJECTIVES],
  suggestedTrials: 1,
  skipInitialPrompt: true,
  timeoutMs: 80 * 60_000,
  progressTimeoutMs: 12 * 60_000,
  setup,
  successCheck,
};
