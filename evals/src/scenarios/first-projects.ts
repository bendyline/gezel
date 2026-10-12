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

import type { FirstProject, Task } from '@bendyline/gezel';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

export const FIRST_PROJECT_CANDIDATES: readonly FirstProject[] = [
  {
    kind: 'type',
    id: 'trip',
    area: 'home',
    title: 'Plan a trip',
    hint: 'A day-by-day plan and a packing list, on a trip board.',
    prompt: 'Plan a trip to Lisbon next spring for the four of us, about a week.',
    typeId: 'trip-planner',
  },
  {
    kind: 'type',
    id: 'celebration',
    area: 'home',
    title: 'Plan a celebration',
    hint: 'Guests, budget and the day itself, on one board.',
    prompt: "Plan Dad's 70th birthday party in May, about 30 guests.",
    typeId: 'event-planner',
  },
  {
    kind: 'type',
    id: 'meals',
    area: 'home',
    title: 'Plan a week of meals',
    hint: 'Dinners for the week and the shopping list, on a kitchen board.',
    prompt: 'Plan a week of meals for two adults and a toddler, mostly vegetarian.',
    typeId: 'meal-planner',
  },
  {
    kind: 'type',
    id: 'language',
    area: 'learning',
    title: 'Practise a language',
    hint: 'Short role-play scenes with a patient tutor.',
    prompt: 'Start a project to practise Spanish with a language tutor. I know the basics.',
    typeId: 'language-trainer',
  },
  {
    kind: 'type',
    id: 'flashcards',
    area: 'learning',
    title: 'Study with flashcards',
    hint: 'A deck of cards to review a few minutes a day.',
    prompt: 'Make me flashcards to learn the capitals of Europe.',
    typeId: 'flashcards',
  },
  {
    kind: 'type',
    id: 'interview',
    area: 'learning',
    title: 'Get ready for an interview',
    hint: 'Practice questions and a plan for the weeks before it.',
    prompt: 'Help me get ready for a job interview as a product designer next month.',
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
  {
    kind: 'type',
    id: 'word-clues',
    area: 'play',
    title: 'Play a word game',
    hint: 'Clues to solve, one word at a time.',
    prompt: "Let's play a word game: give me clues and I'll guess the words.",
    typeId: 'word-clues',
  },
  {
    kind: 'type',
    id: 'invoice',
    area: 'business',
    title: 'Send an invoice',
    hint: 'Your clients and what they owe, on an office board.',
    prompt:
      "Set up my freelance office. I'm a freelance illustrator and I need to send invoices to two clients.",
    typeId: 'freelance-office',
  },
  {
    kind: 'type',
    id: 'posts',
    area: 'content',
    title: 'Plan a week of posts',
    hint: 'Drafts in your voice, ready to publish.',
    prompt: 'Plan a week of LinkedIn posts for my pottery studio.',
    typeId: 'social-feed',
  },
  {
    kind: 'craftbook',
    id: 'notes-to-actions',
    area: 'work',
    title: 'Turn meeting notes into actions',
    hint: 'Who does what by when, from a meeting’s notes.',
    prompt: 'Turn these meeting notes into a list of who does what by when.',
    craftbookId: 'meeting-notes-to-actions',
    sample: { param: 'source', sampleId: 'team-sync' },
  },
  {
    kind: 'craftbook',
    id: 'status-report',
    area: 'work',
    title: 'Write a status report',
    hint: 'A short update your team can read in a minute.',
    prompt:
      'Write a status report for my team: we shipped the new onboarding flow, the billing migration slipped a week, and hiring is on track.',
    craftbookId: 'status-report',
  },
  {
    kind: 'craftbook',
    id: 'spreadsheet',
    area: 'data',
    title: 'Make sense of a spreadsheet',
    hint: 'What is in it, what stands out, and what to look at next.',
    prompt: 'Tell me what stands out in this spreadsheet.',
    craftbookId: 'spreadsheet-findings',
    sample: { param: 'source', sampleId: 'shop-sales' },
  },
  {
    kind: 'craftbook',
    id: 'tidy',
    area: 'data',
    title: 'Tidy up a spreadsheet',
    hint: 'A clean copy, and a list of what was changed.',
    prompt: 'Tidy up this spreadsheet.',
    craftbookId: 'tidy-spreadsheet',
    sample: { param: 'source', sampleId: 'club-members' },
  },
  {
    kind: 'craftbook',
    id: 'proposal',
    area: 'business',
    title: 'Draft a proposal',
    hint: 'Scope, timeline and price, ready to send.',
    prompt: "Draft a proposal for redesigning a local bakery's website, about four weeks of work.",
    craftbookId: 'proposal-sow',
  },
  {
    kind: 'craftbook',
    id: 'newsletter',
    area: 'content',
    title: 'Write a newsletter issue',
    hint: 'This month’s news, written to be read.',
    prompt:
      "Write this month's newsletter for my pottery studio: a new glaze, a spring class, and a studio sale.",
    craftbookId: 'newsletter-issue',
  },
  {
    kind: 'craftbook',
    id: 'explain-code',
    area: 'software',
    title: 'Explain a code folder',
    hint: 'What it does, how it is laid out, and where to start reading.',
    prompt: 'Explain how this code folder works.',
    craftbookId: 'explain-code-folder',
    sample: { param: 'source', sampleId: 'todo-cli' },
  },
  {
    kind: 'craftbook',
    id: 'review-code',
    area: 'software',
    title: 'Review a code folder',
    hint: 'Findings with the file and line, and what is good.',
    prompt: "Review this code and tell me what's wrong.",
    craftbookId: 'review-code-folder',
    sample: { param: 'source', sampleId: 'todo-cli-bugs' },
  },
];

const TRIAL_BUDGET_MS = 40 * 60_000;

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

function typedScenario(first: Extract<FirstProject, { kind: 'type' }>): EvalScenario {
  return {
    id: `first-project-${first.id}`,
    description: `First project "${first.title}": the meester routes it to ${first.typeId} and its lead fills the board.`,
    prompt: first.prompt,
    timeoutMs: TRIAL_BUDGET_MS,
    successCheck: async ({ client, logChanged }: EvalContext): Promise<SuccessCheckResult> => {
      const projects = await client.listProjects().catch(() => ({ projects: [] }));
      for (const summary of projects.projects ?? []) {
        if (summary.id === 'default' || summary.id === 'shared') continue;
        const project = await client.getProject(summary.id).catch(() => null);
        if (project?.projectType?.id !== first.typeId) continue;
        const tasks = await client.listProjectTasks(summary.id).catch(() => ({ tasks: [] }));
        const kickoff = (tasks.tasks ?? []).find((t) => t.num === 1);
        if (!kickoff) continue;
        logChanged(
          'kickoff',
          `[scenario] ${kickoff.ref} ${kickoff.status} step=${kickoff.activeStepId ?? '-'}`,
        );
        const verdict = settled(kickoff);
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
