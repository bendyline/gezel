/**
 * First-project candidates: the work the welcome may offer a newcomer.
 *
 * An entry joins `FIRST_PROJECTS` in core only after it passes here: 2 of 3
 * runs on Gemma 4 E4B and 3 of 3 on Gemma 4 12B, in the default Lockdown
 * posture. The first request is the wrong place to find out a first project
 * does not finish.
 *
 * Each candidate runs exactly as the welcome would run it:
 *
 *  - A typed candidate's sentence goes to the meester, whose kickoff routes it
 *    to the project type; it passes when that project's kickoff task completes
 *    and the board holds what its card promises (`BOARD_CHECKS`). The task's
 *    own gate only asks the data to have grown, which one day of a seven-day
 *    trip satisfied while the person was told "All done" (2026-10-12).
 *  - A craftbook candidate launches through the composer's attached-task
 *    route with no meester turn, on the book's bundled sample when it has
 *    one; it passes when that task completes (its gates hold the deliverable).
 *
 * Each typed card also runs as `first-project-<id>-paraphrase`, the same
 * request in the words a person would use (no "Start a project to…"), which
 * is the case the welcome's own wording cannot cover.
 *
 * `first-projects` is its own suite: every trial is a full first project.
 */

import { FIRST_PROJECTS, type FirstProject, type Task } from '@bendyline/gezel';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { TYPED_FIRST_PROJECT_PARAPHRASES } from '../work-routing/probes.ts';

/**
 * Candidates the welcome does not offer yet. Everything it does offer is
 * read from `FIRST_PROJECTS` itself, so a sentence reworded there is the
 * sentence these trials send.
 */
const WAITING: readonly FirstProject[] = [
  {
    kind: 'type',
    id: 'celebration',
    area: 'home',
    title: 'Plan a celebration',
    hint: 'Guests, budget and the day itself, on one board.',
    prompt: "Plan Dad's 70th birthday party in May, about 30 guests, with a rough budget.",
    typeId: 'event-planner',
  },
  {
    kind: 'type',
    id: 'meals',
    area: 'home',
    title: 'Plan a week of meals',
    hint: 'Dinners for the week and the shopping list, on a kitchen board.',
    prompt:
      'Start a project to plan a week of meals for two adults and a toddler, mostly vegetarian.',
    typeId: 'meal-planner',
  },
  {
    kind: 'type',
    id: 'flashcards',
    area: 'learning',
    title: 'Study with flashcards',
    hint: 'A deck of cards to review a few minutes a day.',
    prompt: 'Start a project to make flashcards for learning the capitals of Europe.',
    typeId: 'flashcards',
  },
  {
    kind: 'type',
    id: 'interview',
    area: 'learning',
    title: 'Get ready for an interview',
    hint: 'Practice questions and a plan for the weeks before it.',
    prompt:
      'Start a project to get ready for my job interview at Northwind as a product designer next month.',
    typeId: 'job-hunt',
  },
  {
    kind: 'type',
    id: 'chess',
    area: 'play',
    title: 'Play a game of chess',
    hint: 'A patient opponent who explains its moves if you ask.',
    prompt: "Let's play a game of chess. I'm a beginner.",
    typeId: 'chess',
  },
];

export const FIRST_PROJECT_CANDIDATES: readonly FirstProject[] = [...FIRST_PROJECTS, ...WAITING];

const TRIAL_BUDGET_MS = 40 * 60_000;

/**
 * A newcomer gets no harness kicks, so neither does a trial of their first
 * project. A generic "write_file the deliverable" kick sent a Job Hunt lead,
 * whose step writes through its project's tools and may not write files,
 * into a loop re-reading pipeline.json (2026-10-14).
 */
const FIRST_PROJECT_REPAIR = 'runtime';

function settled(task: Task): SuccessCheckResult | null {
  if (task.status === 'complete') {
    return {
      done: true,
      success: true,
      reason: `${task.ref} completed`,
      diagnostics: { ref: task.ref, activeStepId: task.activeStepId },
    };
  }
  if (task.status === 'paused' || task.status === 'canceled') {
    return {
      done: true,
      success: false,
      reason: `${task.ref} ${task.status} on step ${task.activeStepId ?? '?'}`,
      diagnostics: { ref: task.ref, status: task.status, activeStepId: task.activeStepId },
    };
  }
  return null;
}

/**
 * Why a completed kickoff left its Output page at the seed, or null when the
 * page's data grew past the kickoff's own floor. Job Hunt and Social Feed
 * leads advanced by hand over an untouched board, and those trials passed
 * (Gemma 4 E4B, 2026-10-14).
 */
async function emptyBoard(
  client: EvalContext['client'],
  projectId: string,
  kickoff: Task,
): Promise<string | null> {
  const step = kickoff.craftbook.steps[0];
  const gate = step?.gate && 'checks' in step.gate ? step.gate : undefined;
  const total = gate?.checks?.find((check) => check.kind === 'totalMinBytes');
  const floor =
    total && total.kind === 'totalMinBytes'
      ? { files: total.files, bytes: total.bytes }
      : step?.advanceWhen
        ? { files: [step.advanceWhen.file], bytes: step.advanceWhen.minBytes ?? 1 }
        : null;
  if (!floor) return null;
  const sizes = await Promise.all(
    floor.files.map((file) =>
      client
        .readProjectWorkspaceFile(projectId, file)
        .then((read) => read.content.length)
        .catch(() => 0),
    ),
  );
  const size = sizes.reduce((sum, n) => sum + n, 0);
  return size >= floor.bytes
    ? null
    : `${floor.files.join(' + ')} is ${size} bytes, needs ${floor.bytes}`;
}

type Board = Record<string, unknown>;
const count = (value: unknown): number =>
  Array.isArray(value)
    ? value.length
    : value && typeof value === 'object'
      ? Object.keys(value).length
      : 0;

/**
 * What each typed candidate's board must hold once its kickoff finishes,
 * read from the files its Output page shows. A failure names the shortfall.
 * A candidate with no entry only needs to meet the kickoff's data floor.
 */
const BOARD_CHECKS: Record<string, (files: Record<string, Board | null>) => string | null> = {
  // "A day-by-day plan and a packing list", for about a week.
  trip: (f) => {
    const days = count(f['trip.json']?.days);
    const packing = count(f['packing.json']?.records);
    return days >= 5 && packing >= 1 ? null : `${days} days, ${packing} packing items`;
  },
  celebration: (f) => {
    const guests = count(f['guests.json']?.records);
    const budget = count(f['budget.json']?.entries);
    return guests >= 1 && budget >= 1 ? null : `${guests} guests, ${budget} budget lines`;
  },
  meals: (f) => {
    const days = count(f['menu.json']?.days);
    return days >= 5 ? null : `${days} days of meals`;
  },
  language: (f) => (f['progress.json']?.scene ? null : 'no scene started'),
  flashcards: (f) => {
    const cards = count(f['deck.json']?.cards);
    return cards >= 8 ? null : `${cards} cards`;
  },
  interview: (f) =>
    count(f['pipeline.json']?.records) + count(f['activity.json']?.events) >= 1
      ? null
      : 'nothing on the pipeline',
  'word-clues': (f) => (count(f['game.json']?.words) >= 1 ? null : 'no words dealt'),
  invoice: (f) => (count(f['invoices.json']?.records) >= 1 ? null : 'no invoice'),
};

async function readBoard(
  client: EvalContext['client'],
  projectId: string,
): Promise<Record<string, Board | null>> {
  const files: Record<string, Board | null> = {};
  const listing = await client.listProjectWorkspace(projectId).catch(() => ({ files: [] }));
  for (const entry of listing.files) {
    if (entry.isDirectory || !entry.path.endsWith('.json')) continue;
    const read = await client.readProjectWorkspaceFile(projectId, entry.path).catch(() => null);
    try {
      files[entry.path] = read ? (JSON.parse(read.content) as Board) : null;
    } catch {
      files[entry.path] = null;
    }
  }
  return files;
}

/**
 * The meester has answered and has no turn running. A typed route creates its
 * project inside that turn, so a turn that ended without one went somewhere
 * else — a recipe in Default, an untyped project, a question to the person —
 * and the trial would otherwise wait out its 40 minutes for nothing.
 */
async function meesterTurnOver(client: EvalContext['client'], meesterId: string): Promise<boolean> {
  const inflight = await client
    .listInflightTurns({ gezelId: meesterId })
    .catch(() => ({ inflight: [null] }));
  if (inflight.inflight.length > 0) return false;
  const { sessions } = await client
    .listChatSessions({ gezelId: meesterId })
    .catch(() => ({ sessions: [] }));
  for (const listed of sessions ?? []) {
    const session = await client.getChatSession(listed.id).catch(() => null);
    if (session?.messages?.some((m) => m.role === 'assistant')) return true;
  }
  return false;
}

function typedScenario(
  first: Extract<FirstProject, { kind: 'type' }>,
  paraphrase?: string,
): EvalScenario {
  return {
    id: `first-project-${first.id}${paraphrase ? '-paraphrase' : ''}`,
    description: `First project "${first.title}"${paraphrase ? " in the person's own words" : ''}: the meester routes it to ${first.typeId} and its lead fills the board.`,
    prompt: paraphrase ?? first.prompt,
    timeoutMs: TRIAL_BUDGET_MS,
    repairPolicy: FIRST_PROJECT_REPAIR,
    successCheck: async ({
      client,
      meesterId,
      logChanged,
    }: EvalContext): Promise<SuccessCheckResult> => {
      const projects = await client.listProjects().catch(() => ({ projects: [] }));
      let typed = false;
      for (const summary of projects.projects ?? []) {
        if (summary.id === 'default' || summary.id === 'shared') continue;
        const project = await client.getProject(summary.id).catch(() => null);
        if (project?.projectType?.id !== first.typeId) continue;
        typed = true;
        const tasks = await client.listProjectTasks(summary.id).catch(() => ({ tasks: [] }));
        // A type's schedules are created before its kickoff: social-feed opens
        // on two cron tasks that wait for their tick, and judging task 1 failed
        // every posts trial in under a minute on a schedule (2026-10-14).
        const kickoff = (tasks.tasks ?? []).filter((t) => !t.cron).sort((a, b) => a.num - b.num)[0];
        if (!kickoff) continue;
        logChanged(
          'kickoff',
          `[scenario] ${kickoff.ref} ${kickoff.status} step=${kickoff.activeStepId ?? '-'}`,
        );
        const verdict = settled(kickoff);
        if (!verdict) continue;
        if (!verdict.done || !verdict.success) return verdict;
        const empty = await emptyBoard(client, summary.id, kickoff);
        if (empty) {
          return {
            done: true,
            success: false,
            reason: `${kickoff.ref} completed with nothing on its page: ${empty}`,
            diagnostics: { ref: kickoff.ref },
          };
        }
        const check = BOARD_CHECKS[first.id];
        if (!check) return verdict;
        const short = check(await readBoard(client, summary.id));
        return short
          ? {
              done: true,
              success: false,
              reason: `${kickoff.ref} completed with a thin board: ${short}`,
              diagnostics: { ref: kickoff.ref, board: short },
            }
          : verdict;
      }
      if (!typed && (await meesterTurnOver(client, meesterId))) {
        return {
          done: true,
          success: false,
          reason: `the meester finished its turn without starting a ${first.typeId} project`,
          diagnostics: { routedElsewhere: true },
        };
      }
      return { done: false };
    },
  };
}

function craftbookScenario(first: Extract<FirstProject, { kind: 'craftbook' }>): EvalScenario {
  let launched: { projectId: string; num: number } | null = null;
  return {
    id: `first-project-${first.id}`,
    description: `First project "${first.title}": ${first.craftbookId} launched from the composer${first.sample ? ' on its sample' : ''}.`,
    prompt: first.prompt,
    skipInitialPrompt: true,
    timeoutMs: TRIAL_BUDGET_MS,
    repairPolicy: FIRST_PROJECT_REPAIR,
    setup: async (ctx: EvalContext): Promise<void> => {
      launched = null;
      const session = await ctx.client.createChatSession({
        gezelId: ctx.meesterId,
        projectId: 'default',
      });
      const response = await ctx.client.launchTaskFromChatSession(session.id, {
        message: first.prompt,
        launch: {
          craftbookId: first.craftbookId,
          params: {},
          ...(first.sample
            ? {
                inputs: {
                  [first.sample.param]: { from: 'sample', sampleId: first.sample.sampleId },
                },
              }
            : {}),
        },
      });
      launched = { projectId: response.task.projectId, num: response.task.num };
      ctx.log(`[scenario:setup] launched ${response.task.ref} from the composer`);
    },
    successCheck: async ({ client, logChanged }: EvalContext): Promise<SuccessCheckResult> => {
      if (!launched) return { done: false };
      const task = await client.getTask(launched.projectId, launched.num).catch(() => null);
      if (!task) return { done: false };
      logChanged('task', `[scenario] ${task.ref} ${task.status} step=${task.activeStepId ?? '-'}`);
      return settled(task) ?? { done: false };
    },
  };
}

export function firstProjectScenarios(): EvalScenario[] {
  const scenarios = FIRST_PROJECT_CANDIDATES.map((first) =>
    first.kind === 'type' ? typedScenario(first) : craftbookScenario(first),
  );
  for (const first of FIRST_PROJECTS) {
    const paraphrase = TYPED_FIRST_PROJECT_PARAPHRASES[first.id];
    if (first.kind === 'type' && paraphrase) scenarios.push(typedScenario(first, paraphrase));
  }
  return scenarios;
}
