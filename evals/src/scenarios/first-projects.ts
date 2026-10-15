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
 *    (its gate already requires the page's data to have grown).
 *  - A craftbook candidate launches through the composer's attached-task
 *    route with no meester turn, on the book's bundled sample when it has
 *    one; it passes when that task completes (its gates hold the deliverable).
 *
 * `first-projects` is its own suite: every trial is a full first project.
 */

import { FIRST_PROJECTS, type FirstProject, type Task } from '@bendyline/gezel';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Candidates the welcome does not offer yet. Everything it does offer is
 * read from `FIRST_PROJECTS` itself, so a sentence reworded there is the
 * sentence these trials send.
 */
const WAITING: readonly FirstProject[] = [
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

function typedScenario(first: Extract<FirstProject, { kind: 'type' }>): EvalScenario {
  return {
    id: `first-project-${first.id}`,
    description: `First project "${first.title}": the meester routes it to ${first.typeId} and its lead fills the board.`,
    prompt: first.prompt,
    timeoutMs: TRIAL_BUDGET_MS,
    repairPolicy: FIRST_PROJECT_REPAIR,
    successCheck: async ({ client, logChanged }: EvalContext): Promise<SuccessCheckResult> => {
      const projects = await client.listProjects().catch(() => ({ projects: [] }));
      for (const summary of projects.projects ?? []) {
        if (summary.id === 'default' || summary.id === 'shared') continue;
        const project = await client.getProject(summary.id).catch(() => null);
        if (project?.projectType?.id !== first.typeId) continue;
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
        if (verdict?.done && verdict.success) {
          const empty = await emptyBoard(client, summary.id, kickoff);
          if (empty) {
            return {
              done: true,
              success: false,
              reason: `${kickoff.ref} completed with nothing on its page: ${empty}`,
              diagnostics: { ref: kickoff.ref },
            };
          }
        }
        if (verdict) return verdict;
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
  return FIRST_PROJECT_CANDIDATES.map((first) =>
    first.kind === 'type' ? typedScenario(first) : craftbookScenario(first),
  );
}
