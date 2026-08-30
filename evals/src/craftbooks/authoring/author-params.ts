import type { Craftbook, CraftbookStep, Task } from '@bendyline/gezel';
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
  progressBytes,
  sendWorkerKickoff,
  taskReferencesCraftbook,
} from './helpers.ts';

/**
 * craftbook-author-params — author a PARAMETERIZED craftbook and run the
 * same recipe twice against two different inputs.
 *
 * Axis: reusability, not step emission. `craftbook-author-linear` already
 * proves a model can emit steps and gates; a book that hardcodes one
 * region passes that bar while being a one-off. Here the same recipe must
 * serve north and south, driven by an invocation parameter rather than by
 * editing the book between runs — the discriminating check is that the two
 * summaries differ, which a parameter-ignoring recipe cannot satisfy.
 * 275 of the bundled books carry a paramSchema, so the shape is readable
 * with craftbook_read. Prompt stays format-blind about the document codec.
 *
 * "Takes an input" is graded on the invocation OR the saved template,
 * whichever shows it. Authoring this scenario found that the local-template
 * writer dropped `paramSchema` outright, which made the template side
 * ungradeable; that is fixed now, but the invocation side stays the primary
 * evidence because it proves the parameter was actually USED, not merely
 * declared. See `invocationParamNames`.
 */

const PROJECT_NAME = 'Regional Sales Rollup';
const BOOK_NAME_HINT = /region|sales|rollup|summar/i;

export const NORTH_CSV_PATH = 'data/north.csv';
export const SOUTH_CSV_PATH = 'data/south.csv';
export const NORTH_SUMMARY_PATH = 'out/north-summary.md';
export const SOUTH_SUMMARY_PATH = 'out/south-summary.md';

/**
 * Two same-shaped exports with deliberately disjoint numbers: no unit or
 * revenue value is shared between the files, so a recipe that ignores its
 * region parameter cannot produce two summaries that legitimately match.
 */
export const NORTH_CSV = `region,rep,units,revenue
north,Annika Vos,142,5325.00
north,Bram Kuiper,88,3102.40
north,Cato Meijer,215,7955.25
north,Douwe Bakker,37,1443.00
north,Elise Hoekstra,164,6068.80
north,Ferdi Jansen,96,3648.00
north,Greet Molenaar,203,7308.00
north,Hidde Postma,51,1912.50
north,Ilse Verweij,178,6497.00
north,Joris Dekker,124,4588.00
`;

export const SOUTH_CSV = `region,rep,units,revenue
south,Karel Smits,309,11433.00
south,Lotte de Wit,72,2664.00
south,Mees Brouwer,255,9435.00
south,Nadia Roos,410,15170.00
south,Olaf Terpstra,133,4921.00
south,Pien Willems,268,9916.00
south,Quirijn Bos,59,2183.00
south,Roos Hendriks,347,12839.00
south,Sander Vermeer,191,7067.00
south,Tessa Groen,226,8362.00
`;

export const AUTHOR_PARAMS_MISSION_OBJECTIVES = [
  'Author ONE reusable craftbook for the monthly regional sales rollup, then run it here for',
  'both regions.',
  'The recipe must take the region as an input supplied when the recipe is started — one recipe',
  'that serves north today and a new region next month, without being edited between runs.',
  "Each run reads that region's export under data/, works out the totals, and writes a short",
  'summary of that region to out/<region>-summary.md.',
  'The eval only passes when the reusable recipe exists, it has been started twice (once per',
  `region), and ${NORTH_SUMMARY_PATH} and ${SOUTH_SUMMARY_PATH} both exist and report their own`,
  "region's numbers rather than the same numbers twice.",
].join(' ');

export const AUTHOR_PARAMS_KICKOFF_MESSAGE = [
  'Every month we get one sales export per region — this month they are already sitting in',
  `${NORTH_CSV_PATH} and ${SOUTH_CSV_PATH} — and the job is always the same one:`,
  "read that region's export, work out the totals (units sold, revenue, and the top rep), and",
  `write a short summary for that region to out/<region>-summary.md, so ${NORTH_SUMMARY_PATH}`,
  `for north and ${SOUTH_SUMMARY_PATH} for south.`,
  'Please build this as a REUSABLE recipe that takes the region as an input when you start it,',
  'rather than a recipe with one region baked into it — we add regions all the time and I want',
  'to run the very same recipe again for a new one without editing it first.',
  'Two steps is plenty: work out the numbers for the region, then write its summary.',
  'Then actually RUN it twice — once for north, once for south — so both summaries end up',
  "written, each carrying its own region's real numbers.",
  'All paths are workspace-root-relative; write outputs with workspace file tools.',
  AUTHORING_TOOL_STEER,
  AUTHORING_PROJECT_PIN,
].join(' ');

/**
 * Runtime-supplied tokens the TaskManager resolves for every task
 * (`taskInterpolationContext`). They appear in plenty of bundled books a
 * model may copy from and prove nothing about parameterization, so the
 * reusability check must not credit them.
 */
const RESERVED_RUNTIME_TOKENS = new Set([
  'task.num',
  'task.ref',
  'task.dir',
  'task.projectId',
  'diffpack.id',
  'diffpack.dir',
]);

/**
 * True when a step carries at least one author-declared `{{token}}` —
 * anywhere in the step, since a parameterized recipe legitimately puts the
 * token in the prompt, a `consumes[].file`, `advanceWhen.file`, or a gate
 * check's path, and gates bury paths several levels down. Exported pure so
 * the token policy is unit-testable without a running daemon.
 */
export function stepUsesInterpolation(step: CraftbookStep): boolean {
  const text = JSON.stringify(step ?? null) ?? '';
  for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
    const token = match[1];
    if (token && !RESERVED_RUNTIME_TOKENS.has(token)) return true;
  }
  return false;
}

/**
 * Names of the parameters a craftbook's `paramSchema` declares. The field
 * is stored permissively (an arbitrary squisq/JSON schema), so read the
 * `properties` map when there is one and otherwise treat the top-level
 * non-metadata keys as the params — a bare `{ "type": "object" }` declares
 * nothing and must not count.
 */
export function paramSchemaPropertyNames(
  paramSchema: Record<string, unknown> | undefined,
): string[] {
  if (!paramSchema) return [];
  const properties = paramSchema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    return Object.keys(properties as Record<string, unknown>);
  }
  const metadata = new Set([
    'type',
    '$schema',
    '$id',
    'title',
    'description',
    'required',
    'additionalProperties',
  ]);
  return Object.keys(paramSchema).filter((key) => !metadata.has(key));
}

/** How many of `tasks` were created from (or embed) `craftbookId`. */
export function countTasksForCraftbook(tasks: readonly Task[], craftbookId: string): number {
  return tasks.filter((task) => taskReferencesCraftbook(task, craftbookId)).length;
}

/**
 * Parameter names actually supplied when the book was started, read off
 * `task.craftbookParams` — the invocation-side evidence that the recipe
 * takes an input.
 *
 * This is not a nicety, for two reasons.
 *
 * Historically it was the only gradeable surface: `craftbook_write(create:
 * true)` posts to `/api/craftbooks/document` with no `projectId`, which
 * lands in `Store.writeLocalCraftbookTemplate`, and that writer dropped
 * `paramSchema` entirely — so a model could emit a perfect schema, have it
 * accepted, and read back `undefined` forever. Authoring this scenario is
 * what surfaced that; it is fixed (both storage paths now share one field
 * list, guarded by `store.craftbook-roundtrip.test.ts`).
 *
 * It remains the primary evidence anyway, because a declared parameter and
 * a USED one are different claims. A book can carry a `paramSchema` nobody
 * ever supplies a value for; only `task.craftbookParams` shows the recipe
 * was actually started with an input. That is the property this scenario
 * is about, so the schema is accepted as corroboration rather than proof.
 */
export function invocationParamNames(tasks: readonly Task[], craftbookId: string): string[] {
  const names = new Set<string>();
  for (const task of tasks) {
    if (!taskReferencesCraftbook(task, craftbookId)) continue;
    for (const name of Object.keys(task.craftbookParams ?? {})) names.add(name);
  }
  return [...names].sort();
}

/** Steps whose tokens can prove parameterization, including a fanout child template. */
function parameterizableSteps(craftbook: Craftbook): CraftbookStep[] {
  return [...craftbook.steps, ...(craftbook.spawn?.steps ?? [])];
}

async function setup(ctx: EvalContext): Promise<void> {
  const projectId = await ensureAuthoringProject(ctx, {
    name: PROJECT_NAME,
    about:
      'Monthly per-region sales exports land under data/. Each region gets the same treatment: ' +
      'total its units and revenue and publish a short summary under out/. New regions are ' +
      'added regularly, so the routine has to survive without being rewritten each time.',
    missionObjectives: AUTHOR_PARAMS_MISSION_OBJECTIVES,
  });
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: NORTH_CSV_PATH,
    content: NORTH_CSV,
  });
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: SOUTH_CSV_PATH,
    content: SOUTH_CSV,
  });
  ctx.log(`[authoring:setup] seeded ${NORTH_CSV_PATH} + ${SOUTH_CSV_PATH} (10 rows each)`);
  // The authoring worker, not the meester — the meester persona refuses
  // direct authorship (see AUTHORING_WORKER_ABOUT).
  const workerId = await ensureAuthoringWorker(ctx, 'Reza');
  await sendWorkerKickoff(ctx, workerId, projectId, AUTHOR_PARAMS_KICKOFF_MESSAGE);
}

const TOTAL_CHECKS = 7;

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const projectId = await findProjectIdByName(ctx.client, PROJECT_NAME);
  if (!projectId) return { done: false };

  const failures: string[] = [];
  const book = await findAuthoredCraftbook(ctx.client, {
    projectId,
    minSteps: 2,
    nameHint: BOOK_NAME_HINT,
  });
  // Grade the workspace where the recipe's tasks actually ran — the prompt
  // pins the seeded project, but a detour must not zero out real work.
  let gradeProjectId = projectId;
  let paramNames: string[] = [];
  if (!book) {
    failures.push(
      'no reusable authored craftbook with at least 2 steps exists yet — author the regional sales rollup as a reusable craftbook template, not as ad-hoc chat work',
    );
  } else {
    // Ordered so the FIRST failure — the one that drives the repair nudge
    // — is always true of the state at that moment: a book-only property
    // first, then the invocation-side ones, which cannot be judged at all
    // until a task exists.
    paramNames = paramSchemaPropertyNames(book.craftbook.paramSchema);
    if (!parameterizableSteps(book.craftbook).some(stepUsesInterpolation)) {
      failures.push(
        `no step of craftbook "${book.craftbook.id}" refers to its input parameter — the region has to reach the steps (the export it reads and the summary it writes must be derived from the parameter, not hardcoded to one region)`,
      );
    }
    const found = await findTaskForCraftbookAnywhere(ctx.client, projectId, book.craftbook.id);
    if (!found) {
      failures.push(
        `no task has been created from craftbook "${book.craftbook.id}" yet — start the recipe on this project for the north region`,
      );
    } else {
      gradeProjectId = found.projectId;
      const { tasks } = await ctx.client.listProjectTasks(gradeProjectId);
      // Either surface proves the recipe takes an input: a declared
      // paramSchema (project-local books keep it) or the params a run was
      // actually started with. The local-template writer drops the schema
      // — see `invocationParamNames` — so requiring only the schema would
      // make this check unpassable.
      paramNames = [...new Set([...paramNames, ...invocationParamNames(tasks, book.craftbook.id)])];
      if (paramNames.length === 0) {
        failures.push(
          `craftbook "${book.craftbook.id}" was started with no invocation parameters — the recipe must take the region as an input parameter supplied when the recipe is started, so one recipe serves both regions`,
        );
      }
      const runs = countTasksForCraftbook(tasks, book.craftbook.id);
      if (runs < 2) {
        failures.push(
          `craftbook "${book.craftbook.id}" has only been started ${runs} time(s) — start the SAME recipe a second time for the other region (supply the other region as its input) instead of editing the recipe or writing the second summary by hand`,
        );
      }
    }
  }

  const workspace = workspaceFromClient(ctx.client, gradeProjectId);
  const gateResult = await evaluateCraftbookGateChecks(
    [
      { kind: 'minBytes', file: NORTH_SUMMARY_PATH, bytes: 80 },
      { kind: 'minBytes', file: SOUTH_SUMMARY_PATH, bytes: 80 },
    ],
    workspace,
  );
  failures.push(...gateResult.failures);
  const northSummary = await workspace.read(NORTH_SUMMARY_PATH);
  const southSummary = await workspace.read(SOUTH_SUMMARY_PATH);
  // The discriminating check: the two exports share no unit or revenue
  // figure, so identical summaries mean the recipe never read its input.
  if (
    northSummary !== null &&
    southSummary !== null &&
    northSummary.trim() === southSummary.trim()
  ) {
    failures.push(
      `${NORTH_SUMMARY_PATH} and ${SOUTH_SUMMARY_PATH} have identical contents — each run must read its own region's export and report that region's own totals, so the two summaries cannot match`,
    );
  }

  return finishAuthoringPoll(ctx, {
    scenarioId: authorParamsScenario.id,
    projectId,
    totalChecks: TOTAL_CHECKS,
    failures,
    bytes:
      progressBytes(
        northSummary,
        southSummary,
        book ? JSON.stringify(book.craftbook.steps.map((step) => step.id)) : null,
        paramNames.join(','),
      ) +
      500 * (await countCraftbookToolCalls(ctx, projectId)),
    repairPath: 'craftbook: regional sales rollup',
    repairDirective: [
      'CRAFTBOOK_PARAMS_REPAIR: this eval grades the craftbook catalog and the task graph, not a',
      'chat summary. Fix the FIRST failure above using craftbook/task tools: the ONE reusable',
      'craftbook must refer to its region input from its steps (the export it reads and the',
      'summary path it writes), and it must be started TWICE — once supplying north as the',
      'input, once supplying south — until both summaries exist with their own region numbers.',
      'Do not author a second craftbook and do not hand-write the summaries.',
    ].join(' '),
    successReason:
      'authored one parameterized craftbook, ran it twice with different region inputs, and both region summaries exist with distinct contents',
  });
}

export const authorParamsScenario: EvalScenario = {
  id: 'craftbook-author-params',
  description:
    'Author a PARAMETERIZED craftbook for a per-region sales rollup (the region is an ' +
    'invocation parameter reaching the steps, not a hardcoded value), then run the same recipe ' +
    'twice — north and south — and prove the two summaries differ.',
  prompt: AUTHOR_PARAMS_KICKOFF_MESSAGE,
  evidenceTexts: [AUTHOR_PARAMS_KICKOFF_MESSAGE, AUTHOR_PARAMS_MISSION_OBJECTIVES],
  suggestedTrials: 1,
  skipInitialPrompt: true,
  timeoutMs: 35 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  successCheck,
};
