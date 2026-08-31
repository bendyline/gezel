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
 * craftbook-author-fanout — author a DECLARATIVE FANOUT craftbook: one
 * reusable recipe that reads a list and produces one run per item.
 *
 * Axis: the hardest craftbook document shape. When the fanout step
 * activates, the runtime reads the JSON array the book's spawn block names
 * and creates one child task per item, substituting each item's fields into
 * the child step prompts and paths — NO model tool call drives it, so the
 * model has to express the fanout structurally in the document it writes.
 * The linear scenario grades a straight-line book; this one grades whether
 * a model reaches for the per-item shape at all. The step ceiling below is
 * the anti-paste floor: repeating the same steps once per store is the
 * cheap escape, and it must not score. Prompt stays format-blind about the
 * document codec.
 *
 * Authoring this scenario found three product bugs, all since FIXED. They are
 * recorded here because they are the reason the grader is shaped the way it is,
 * and because the same drift would silently make it unwinnable again:
 *
 *   1. `docFromCraftbook` omitted `spawn`, so `craftbook_read` on invoice-run /
 *      nightly-fix-sweep / pull-request-review handed the model a document with
 *      no spawn block — the shape was not discoverable by reading, which is the
 *      route AUTHORING_TOOL_STEER sends every model down.
 *   2. `craftbookFromDoc` omitted it too, so `craftbook_write` ACCEPTED a
 *      document carrying a spawn block, returned 201, and saved a craftbook
 *      without one.
 *   3. `Store.writeLocalCraftbookTemplate` — the writer `craftbook_write(create:
 *      true)` routes to — dropped it again at the persistence layer.
 *
 * Guarded now by craftbook-doc.roundtrip.test.ts and
 * store.craftbook-roundtrip.test.ts, both of which assert field-completeness
 * against the schema rather than against a hand-written list.
 *
 * The grader was deliberately NOT softened while those bugs stood: a scenario
 * that routes around a real product defect stops measuring anything, and the
 * failure it was reporting was the true one.
 */

const PROJECT_NAME = 'Store Health Sweep';
const BOOK_NAME_HINT = /store|health|sweep|audit/i;

export const STORES_JSON_PATH = 'data/stores.json';

/**
 * Four stores with meaningfully different numbers, so a per-store write-up
 * that merely restates the fixture still has to read ITS OWN item.
 */
export const STORES: ReadonlyArray<{
  slug: string;
  name: string;
  city: string;
  openIssues: number;
  lastAuditDays: number;
}> = [
  { slug: 'harbor', name: 'Harbor Books', city: 'Rotterdam', openIssues: 7, lastAuditDays: 41 },
  { slug: 'linden', name: 'Linden Florists', city: 'Utrecht', openIssues: 2, lastAuditDays: 12 },
  {
    slug: 'northside',
    name: 'Northside Gym',
    city: 'Groningen',
    openIssues: 13,
    lastAuditDays: 96,
  },
  { slug: 'milo', name: "Milo's Deli", city: 'Delft', openIssues: 0, lastAuditDays: 5 },
];

export const STORES_JSON = `${JSON.stringify(STORES, null, 2)}\n`;

export const STORE_HEALTH_PATHS: readonly string[] = STORES.map(
  (store) => `out/${store.slug}-health.md`,
);

/** Liveness floor per write-up — a stub heading alone must not pass. */
const HEALTH_MIN_BYTES = 60;

/**
 * Anti-paste ceiling: a correct book is roughly prepare → fan out →
 * collect plus ONE per-item step. Four pasted copies of the per-store work
 * cannot fit under this.
 */
const MAX_TOTAL_STEPS = 6;

export const AUTHOR_FANOUT_MISSION_OBJECTIVES = [
  `Produce a short health write-up for every store listed in ${STORES_JSON_PATH} — one file per`,
  "store, named after that store's slug (out/<slug>-health.md) — and get all four written here.",
  'Do it by authoring ONE reusable craftbook that derives its per-store work from the store list',
  'itself: the recipe must not repeat the same steps once per store, and it must not have to be',
  'started once per store.',
  'The store list will grow, so the recipe has to work off whatever the list contains rather than',
  'the four stores that happen to be there today.',
  'The eval only passes when the craftbook exists as a reusable template, one run of it produced',
  'a separate unit of work per store, and all four out/<slug>-health.md files exist in this',
  "project's workspace.",
].join(' ');

export const AUTHOR_FANOUT_KICKOFF_MESSAGE = [
  `We have four stores in ${STORES_JSON_PATH}, and every one of them needs the same short health`,
  'write-up — one file per store at out/<slug>-health.md, using the slug from the store list',
  `(so ${STORE_HEALTH_PATHS[0]} for the first one).`,
  "Each write-up should cover that store's open issues, how long it has been since its last",
  'audit, and what you would do about it.',
  'Build this as ONE reusable recipe that reads the store list and produces a separate write-up',
  'per store on its own. I do not want four copies of the same steps pasted into the recipe, and',
  'I do not want to start the recipe four times by hand — one run over the list should give me',
  'all four write-ups.',
  'The store list will grow later, so the recipe has to work off whatever is in the list rather',
  'than the four stores we happen to have today.',
  'Then run it and get all four write-ups produced.',
  'All paths are workspace-root-relative; write outputs with workspace file tools.',
  AUTHORING_TOOL_STEER,
  AUTHORING_PROJECT_PIN,
].join(' ');

async function setup(ctx: EvalContext): Promise<void> {
  const projectId = await ensureAuthoringProject(ctx, {
    name: PROJECT_NAME,
    about:
      'A small retail chain. Every store on the list needs the same short health write-up, ' +
      'produced by one reusable craftbook that covers the whole list in a single run.',
    missionObjectives: AUTHOR_FANOUT_MISSION_OBJECTIVES,
  });
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: STORES_JSON_PATH,
    content: STORES_JSON,
  });
  ctx.log(`[authoring:setup] seeded ${STORES_JSON_PATH} (${STORES.length} stores)`);
  const workerId = await ensureAuthoringWorker(ctx, 'Reza');
  await sendWorkerKickoff(ctx, workerId, projectId, AUTHOR_FANOUT_KICKOFF_MESSAGE);
}

/**
 * Four structural milestones plus one byte check per store — the write-ups
 * are counted individually so a run that fanned out but only finished two
 * stores scores above one that never fanned out at all.
 */
const TOTAL_CHECKS = 4 + STORE_HEALTH_PATHS.length;

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const projectId = await findProjectIdByName(ctx.client, PROJECT_NAME);
  if (!projectId) return { done: false };

  const failures: string[] = [];
  const book = await findAuthoredCraftbook(ctx.client, {
    projectId,
    minSteps: 1,
    nameHint: BOOK_NAME_HINT,
  });
  // Grade the workspace where the recipe's task actually ran — the prompt
  // pins the seeded project, but a detour must not zero out real work.
  let gradeProjectId = projectId;
  let perStoreRuns = 0;
  if (!book) {
    failures.push(
      'no reusable authored craftbook exists yet — author the store health sweep as a craftbook template, not as ad-hoc chat work',
    );
  } else {
    const bookId = book.craftbook.id;
    const spawn = book.craftbook.spawn;
    if (!spawn) {
      failures.push(
        `craftbook "${bookId}" declares no per-item fanout over the store list — the recipe must derive its per-store work from the store list itself (one item, one run) rather than repeating steps once per store`,
      );
    } else if (!spawn.overFile.includes('stores')) {
      failures.push(
        `craftbook "${bookId}" fans out over "${spawn.overFile}", which does not name the store list — point it at ${STORES_JSON_PATH} (or a list derived from it) so one run covers every store`,
      );
    }
    const totalSteps = book.craftbook.steps.length + (spawn?.steps.length ?? 0);
    if (totalSteps > MAX_TOTAL_STEPS) {
      failures.push(
        `craftbook "${bookId}" carries ${totalSteps} steps — that is the per-store work pasted in rather than derived from the list; keep the recipe to at most ${MAX_TOTAL_STEPS} steps and let one run cover every store`,
      );
    }

    const found = await findTaskForCraftbookAnywhere(ctx.client, projectId, bookId);
    if (found) gradeProjectId = found.projectId;
    const tasks = await ctx.client
      .listProjectTasks(gradeProjectId)
      .then((res) => res.tasks)
      .catch(() => []);
    // A declarative fanout's children are snapshotted off the host's spawn
    // template, so they carry neither the book id nor its catalog source —
    // the parent link is what is actually observable. Manual re-invocations
    // of the same book are counted the other way.
    const referencing = tasks.filter((task) => taskReferencesCraftbook(task, bookId)).length;
    const children = found
      ? tasks.filter((task) => task.parentTaskRef === found.task.ref).length
      : 0;
    perStoreRuns = Math.max(referencing, children);
    if (perStoreRuns < STORES.length) {
      failures.push(
        `craftbook "${bookId}" has produced ${perStoreRuns} of ${STORES.length} per-store runs — invoke the recipe on this project and make sure its fanout step really fans out over ${STORES_JSON_PATH}, so each store gets its own run`,
      );
    }
  }

  const workspace = workspaceFromClient(ctx.client, gradeProjectId);
  const gateResult = await evaluateCraftbookGateChecks(
    STORE_HEALTH_PATHS.map((file) => ({
      kind: 'minBytes' as const,
      file,
      bytes: HEALTH_MIN_BYTES,
    })),
    workspace,
  );
  failures.push(...gateResult.failures);
  const healthTexts = await Promise.all(STORE_HEALTH_PATHS.map((file) => workspace.read(file)));

  return finishAuthoringPoll(ctx, {
    scenarioId: authorFanoutScenario.id,
    projectId,
    totalChecks: TOTAL_CHECKS,
    failures,
    bytes:
      progressBytes(
        ...healthTexts,
        book ? JSON.stringify(book.craftbook.steps.map((step) => step.id)) : null,
        book?.craftbook.spawn ? JSON.stringify(book.craftbook.spawn) : null,
      ) +
      1000 * perStoreRuns +
      500 * (await countCraftbookToolCalls(ctx, projectId)),
    // A finished per-store run is a declared unit of work, not byte churn.
    // It rides `milestones` (which the plateau key honours) as well as
    // `bytes` (which it does not): the first hard-suite run completed three
    // extra runs while the plateau key `…:2:targetnone:fr1tjwffw:rp0:rf0`
    // never moved, and the stall path killed the trial as "stalled 18m".
    milestones: perStoreRuns,
    repairPath: 'craftbook: store health sweep',
    repairDirective: [
      'CRAFTBOOK_FANOUT_REPAIR: this eval grades the craftbook document and the task graph, not a',
      'chat summary. Fix the FIRST failure above with the craftbook/task tools.',
      'The recipe must be ONE book whose per-store work is declared once and driven off the store',
      `list at ${STORES_JSON_PATH} — read an existing book with craftbook_read to see the document`,
      'shape, then save yours with craftbook_write, invoke it once, and let the run',
      `produce every out/<slug>-health.md (at least ${HEALTH_MIN_BYTES} bytes each).`,
    ].join(' '),
    successReason: `authored a single fanout craftbook over ${STORES_JSON_PATH}, one run produced a unit of work per store, and all ${STORES.length} write-ups exist`,
  });
}

export const authorFanoutScenario: EvalScenario = {
  id: 'craftbook-author-fanout',
  description:
    'Author a DECLARATIVE FANOUT craftbook: one reusable recipe whose per-item work is declared ' +
    'once and driven off a seeded 4-store list, invoked once, producing one run and one ' +
    'write-up per store. Graded on the spawn declaration, an anti-paste step ceiling, the ' +
    'per-store run count, and all four output files.',
  prompt: AUTHOR_FANOUT_KICKOFF_MESSAGE,
  evidenceTexts: [AUTHOR_FANOUT_KICKOFF_MESSAGE, AUTHOR_FANOUT_MISSION_OBJECTIVES],
  suggestedTrials: 1,
  skipInitialPrompt: true,
  timeoutMs: 45 * 60_000,
  progressTimeoutMs: 12 * 60_000,
  setup,
  successCheck,
};
