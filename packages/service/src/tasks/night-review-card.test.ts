import { DEFAULT_NIGHT_SHIFT_WINDOW, type GezelConfig, type Question } from '@bendyline/gezel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type NightShiftReviewCardDeps, postNightShiftReviewCard } from './night-review-card.js';

const review = vi.hoisted(() => ({
  tasksCompleted: [] as unknown[],
  oversight: null as { num: number; status: string } | null,
}));
const WINDOW_KEY = '2026-10-13';

vi.mock('./night-review.js', () => ({
  buildNightShiftReview: async () => ({
    windowKey: WINDOW_KEY,
    tasksCompleted: review.tasksCompleted,
    reports: [],
    diffpacks: [],
  }),
  nightShiftReportAttachmentPath: () => '',
}));
vi.mock('./night-tally.js', () => ({
  buildNightShiftTally: async () => null,
  nightShiftTallyPeriod: () => ({}),
}));
vi.mock('../digest/weekly-recap.js', () => ({ writeWeeklyRecap: async () => null }));
vi.mock('../meester/night-shift-oversight.js', () => ({
  findNightShiftOversightTask: async () => review.oversight,
}));

const settledAt = new Date('2026-10-14T07:00:00.000Z');
const hoursBefore = (hours: number) =>
  new Date(settledAt.getTime() - hours * 60 * 60_000).toISOString();

let written: Question[];
let logged: unknown[];

function deps(config: Partial<GezelConfig>): NightShiftReviewCardDeps {
  return {
    store: {
      listProjectQuestions: async () => [],
      readConfig: async () => config,
      writeQuestion: async (q: Question) => {
        written.push(q);
      },
    },
    // The Meester's oversight task is active from minute one, so a fresh
    // install is always owed a review — the case that produced the complaint.
    tasks: { list: async () => [{ nightShift: { enabled: true } }] },
    history: {
      log: async (entry: unknown) => {
        logged.push(entry);
      },
    },
    contentIndex: {},
    reportActions: {},
    diffpacks: {},
    chatEvents: { publishProjectEvent: () => {} },
    nightShift: {
      currentWindow: () => DEFAULT_NIGHT_SHIFT_WINDOW,
      windowOutcome: () => ({ windowKey: WINDOW_KEY, ran: false, reason: 'asleep' }),
    },
    hasNightSweepProject: async () => false,
    nightShiftNow: () => settledAt,
  } as unknown as NightShiftReviewCardDeps;
}

beforeEach(() => {
  review.tasksCompleted = [];
  review.oversight = null;
  written = [];
  logged = [];
});

describe('the morning card during first use', () => {
  it('says nothing about a quiet night on a new install', async () => {
    await postNightShiftReviewCard(deps({ firstUseAt: hoursBefore(2) }), WINDOW_KEY);
    expect(written).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('reports a quiet night once the install is a few days old', async () => {
    await postNightShiftReviewCard(deps({ firstUseAt: hoursBefore(4 * 24) }), WINDOW_KEY);
    expect(written).toHaveLength(1);
    expect(written[0]!.prompt).toContain("Your crew couldn't work last night");
  });

  it('reports a quiet night on an established install', async () => {
    await postNightShiftReviewCard(deps({}), WINDOW_KEY);
    expect(written).toHaveLength(1);
  });

  it('still tells a new install that its night review is paused', async () => {
    review.oversight = { num: 1, status: 'paused' };
    await postNightShiftReviewCard(deps({ firstUseAt: hoursBefore(2) }), WINDOW_KEY);
    expect(written).toHaveLength(1);
  });

  it('still reports a night that got work done on a new install', async () => {
    review.tasksCompleted = [{ projectId: 'default', num: 2, title: 'Draft the brief' }];
    await postNightShiftReviewCard(deps({ firstUseAt: hoursBefore(2) }), WINDOW_KEY);
    expect(written).toHaveLength(1);
    expect(written[0]!.prompt).toContain('The night shift finished 1 task');
  });
});
