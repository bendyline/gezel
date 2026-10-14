import {
  DEFAULT_NIGHT_SHIFT_WINDOW,
  type GezelConfig,
  type HistoryEvent,
  type NightShiftQuietReason,
  type NightShiftReviewIntent,
  type Question,
} from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NightShiftReviewCardDeps, postNightShiftReviewCard } from './night-review-card.js';

const WINDOW_KEY = '2026-10-13';
const settledAt = new Date('2026-10-14T07:00:00.000Z');
const hoursBefore = (hours: number) =>
  new Date(settledAt.getTime() - hours * 60 * 60_000).toISOString();
const daysBefore = (days: number) => hoursBefore(days * 24);

const night = vi.hoisted(() => ({
  tasksCompleted: [] as unknown[],
  reports: [] as unknown[],
  diffpacks: [] as unknown[],
  oversight: null as unknown,
}));

vi.mock('./night-review.js', () => ({
  buildNightShiftReview: async () => ({
    windowKey: '2026-10-13',
    windowStart: new Date('2026-10-13T22:00:00.000Z').toISOString(),
    windowEnd: new Date('2026-10-14T06:00:00.000Z').toISOString(),
    tasksCompleted: night.tasksCompleted,
    reports: night.reports,
    diffpacks: night.diffpacks,
  }),
  nightShiftReportAttachmentPath: (r: { projectId: string; path: string }) =>
    `projects/${r.projectId}/artifacts/${r.path}`,
}));
vi.mock('./night-tally.js', () => ({
  buildNightShiftTally: async () => null,
  nightShiftTallyPeriod: () => ({}),
}));
vi.mock('../digest/weekly-recap.js', () => ({ writeWeeklyRecap: async () => null }));
vi.mock('../meester/night-shift-oversight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../meester/night-shift-oversight.js')>()),
  findNightShiftOversightTask: async () => night.oversight,
}));

const OVERSIGHT = {
  ref: 'default/1',
  num: 1,
  projectId: 'default',
  title: 'Night-shift oversight: project review',
  status: 'active',
  nightShift: { enabled: true, onceADay: true },
};
const PERSONAL_NIGHT_TASK = {
  ref: 'shop/3',
  num: 3,
  projectId: 'shop',
  title: 'Nightly security review',
  status: 'active',
  nightShift: { enabled: true },
};

let questions: Question[];
let written: Question[];
let published: Array<{ type: string; question: Question }>;
let events: HistoryEvent[];

interface Scenario {
  config?: Partial<GezelConfig>;
  reason?: NightShiftQuietReason;
  ran?: boolean;
  activeTasks?: unknown[];
  projects?: unknown[];
  packs?: unknown[];
  sweep?: boolean;
}

function deps(scenario: Scenario = {}): NightShiftReviewCardDeps {
  const ran = scenario.ran ?? false;
  return {
    store: {
      listProjectQuestions: async () => questions,
      readConfig: async () => scenario.config ?? {},
      listProjects: async () => scenario.projects ?? [],
      writeQuestion: async (q: Question) => {
        written.push(q);
        questions = [...questions.filter((x) => x.id !== q.id), q];
      },
    },
    tasks: { list: async () => scenario.activeTasks ?? [OVERSIGHT, PERSONAL_NIGHT_TASK] },
    history: {
      log: async (entry: Omit<HistoryEvent, 'id' | 'at'>) => {
        events.push({ ...entry, id: `e${events.length}`, at: settledAt.toISOString() });
      },
      listEvents: async () => events,
    },
    contentIndex: {},
    reportActions: {},
    diffpacks: { list: async () => scenario.packs ?? [] },
    chatEvents: {
      publishProjectEvent: (_projectId: string, event: { type: string; question: Question }) => {
        published.push(event);
      },
    },
    nightShift: {
      currentWindow: () => DEFAULT_NIGHT_SHIFT_WINDOW,
      windowOutcome: () => ({
        windowKey: WINDOW_KEY,
        ran,
        ...(ran ? {} : { reason: scenario.reason ?? 'asleep' }),
      }),
    },
    hasNightSweepProject: async () => scenario.sweep ?? false,
    nightShiftNow: () => settledAt,
  } as unknown as NightShiftReviewCardDeps;
}

function earlierCard(
  windowKey: string,
  intent: Partial<NightShiftReviewIntent> = {},
  answered = false,
): Question {
  return {
    id: `card-${windowKey}`,
    projectId: 'default',
    gezelId: 'wren',
    sessionId: '',
    prompt: 'An earlier morning.',
    createdAt: `${windowKey}T07:00:00.000Z`,
    intent: { kind: 'night-shift-review', windowKey, tasksCompleted: 0, reports: [], ...intent },
    ...(answered ? { answer: { selectedChoices: [0], at: `${windowKey}T08:00:00.000Z` } } : {}),
  };
}

function recordedNight(windowKey: string, at: string, ran = false): HistoryEvent {
  return {
    id: `night-${windowKey}`,
    at,
    kind: 'night-shift.window-settled',
    projectId: 'default',
    summary: `Night shift ${windowKey}`,
    details: { windowKey, ran },
  };
}

const settledRecords = () => events.filter((e) => e.kind === 'night-shift.window-settled');
const newCards = () => written.filter((q) => !q.answer);

beforeEach(() => {
  night.tasksCompleted = [];
  night.reports = [];
  night.diffpacks = [];
  night.oversight = null;
  questions = [];
  written = [];
  published = [];
  events = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a night that did something', () => {
  it('gets a card even during first use, and the night is recorded', async () => {
    night.tasksCompleted = [{ projectId: 'shop', ref: 'shop/2', title: 'Draft the brief' }];
    await postNightShiftReviewCard(deps({ config: { firstUseAt: hoursBefore(20) } }), WINDOW_KEY);
    expect(newCards()).toHaveLength(1);
    expect(newCards()[0]!.prompt).toContain('The night shift finished 1 task');
    expect(published.map((e) => e.type)).toEqual(['question_asked']);
    expect(settledRecords()).toHaveLength(1);
    expect(settledRecords()[0]!.details).toMatchObject({
      windowKey: WINDOW_KEY,
      tasksCompleted: 1,
    });
  });

  it('retires only the earlier cards it repeats, and leaves answered ones alone', async () => {
    const fridaysReports = [{ projectId: 'shop', path: 'reports/security.md', actionCount: 2 }];
    questions = [
      earlierCard('2026-10-09', { tasksCompleted: 1, reports: fridaysReports }),
      earlierCard('2026-10-10', { quiet: { reason: 'quota-held' } }),
      // Its proposal is still listed on the new card; its tally was one night's.
      earlierCard('2026-10-11', {
        indexing: { filesIndexed: 40, filesReviewed: 0, mediaDescribed: 0 },
      }),
      earlierCard('2026-10-12', { tasksCompleted: 2 }, true),
    ];
    night.tasksCompleted = [{ projectId: 'shop', ref: 'shop/2', title: 'Draft the brief' }];
    await postNightShiftReviewCard(deps(), WINDOW_KEY);

    expect(published.map((e) => [e.type, e.question.id])).toEqual([
      ['question_asked', newCards()[0]!.id],
      ['question_answered', 'card-2026-10-10'],
      ['question_answered', 'card-2026-10-11'],
    ]);
    expect(written.find((q) => q.id === 'card-2026-10-10')?.answer).toMatchObject({
      silentSkip: true,
    });
    expect(written.some((q) => q.id === 'card-2026-10-12')).toBe(false);
    const open = questions.filter(
      (q) => !q.answer && q.intent?.kind === 'night-shift-review',
    ) as Array<Question & { intent: NightShiftReviewIntent }>;
    expect(open.map((q) => q.intent.windowKey).sort()).toEqual(['2026-10-09', WINDOW_KEY]);
  });

  it('keeps an unread night with reports when a quiet night follows it', async () => {
    // Friday left reports nobody has opened; Saturday sat on battery.
    questions = [
      earlierCard('2026-10-12', {
        tasksCompleted: 1,
        reports: [
          { projectId: 'shop', path: 'reports/security.md', actionCount: 2 },
          { projectId: 'shop', path: 'reports/digest-2026-W41.md', actionCount: 0 },
          { projectId: 'default', path: 'night-shift-report-2026-10-12.md', actionCount: 1 },
        ],
      }),
      earlierCard('2026-10-11', {
        indexing: { filesIndexed: 40, filesReviewed: 0, mediaDescribed: 0 },
      }),
      earlierCard('2026-10-10', { weeklyRecap: { week: '2026-W40', path: 'reports/r.md' } }),
    ];
    await postNightShiftReviewCard(deps({ reason: 'on-battery' }), WINDOW_KEY);

    expect(newCards().map((q) => (q.intent as NightShiftReviewIntent).quiet)).toEqual([
      { reason: 'on-battery' },
    ]);
    expect(written.filter((q) => q.answer)).toEqual([]);
    expect(published.map((e) => e.type)).toEqual(['question_asked']);
  });

  it('does not count a proposal left waiting from an earlier night', async () => {
    night.diffpacks = [{ projectId: 'shop', packId: '7', title: 'Fix the cart', status: 'ready' }];
    const pack = (createdAt: string, sealedAt?: string) => ({
      packId: '7',
      createdAt,
      ...(sealedAt ? { sealedAt } : {}),
    });
    await postNightShiftReviewCard(
      deps({ packs: [pack(daysBefore(3), daysBefore(3))] }),
      WINDOW_KEY,
    );
    expect(newCards()).toEqual([]);
    expect(settledRecords()[0]!.details).toMatchObject({ proposals: 0 });

    events = [];
    await postNightShiftReviewCard(
      deps({ packs: [pack(hoursBefore(5), hoursBefore(4))] }),
      WINDOW_KEY,
    );
    expect(newCards()).toHaveLength(1);
    expect(newCards()[0]!.prompt).toBe('The night shift left 1 change proposal for you.');
  });

  it('does not count the nightly review of no projects as a report', async () => {
    night.oversight = { ...OVERSIGHT };
    night.reports = [
      {
        projectId: 'default',
        projectName: 'Default',
        path: 'night-shift-report.md',
        title: 'Night shift report',
        actionCounts: { total: 0, suggested: 0, fired: 0, applied: 0, dismissed: 0 },
      },
    ];
    await postNightShiftReviewCard(
      deps({ projects: [{ id: 'default', name: 'Default' }] }),
      WINDOW_KEY,
    );
    expect(newCards()).toEqual([]);

    events = [];
    await postNightShiftReviewCard(
      deps({
        projects: [
          { id: 'default', name: 'Default' },
          { id: 'shop', name: 'Shop', status: 'active' },
        ],
      }),
      WINDOW_KEY,
    );
    expect(newCards()).toHaveLength(1);
    expect(newCards()[0]!.prompt).toBe('The night shift left 1 report for you.');
  });
});

describe('a night that produced nothing', () => {
  it('posts nothing for an ordinary reason, but still records the night', async () => {
    for (const reason of ['asleep', 'no-work', 'stopped'] as const) {
      events = [];
      await postNightShiftReviewCard(deps({ reason, sweep: true }), WINDOW_KEY);
      expect(written).toEqual([]);
      expect(published).toEqual([]);
      expect(settledRecords()).toHaveLength(1);
      expect(settledRecords()[0]!.details).toMatchObject({ windowKey: WINDOW_KEY, reason });
    }
  });

  it('says nothing about a paused review on its own: it retries by itself', async () => {
    night.oversight = { ...OVERSIGHT, status: 'paused' };
    await postNightShiftReviewCard(deps({ reason: 'no-work' }), WINDOW_KEY);
    expect(written).toEqual([]);
  });

  it('tells an established install once about a reason it can fix', async () => {
    await postNightShiftReviewCard(deps({ reason: 'on-battery' }), WINDOW_KEY);
    expect(newCards()).toHaveLength(1);
    const card = newCards()[0]!;
    expect(card.prompt).toBe(
      'Your crew waited last night because the computer was running on battery.',
    );
    expect((card.intent as NightShiftReviewIntent).quiet).toEqual({ reason: 'on-battery' });
  });

  it('does not count the Meester’s own review as work the person was owed', async () => {
    await postNightShiftReviewCard(
      deps({ reason: 'on-battery', activeTasks: [OVERSIGHT] }),
      WINDOW_KEY,
    );
    expect(written).toEqual([]);
  });

  it('says the same reason once, until a night has run in between', async () => {
    questions = [earlierCard('2026-10-11', { quiet: { reason: 'on-battery' } }, true)];
    events = [
      recordedNight('2026-10-11', daysBefore(2)),
      recordedNight('2026-10-12', daysBefore(1)),
    ];
    await postNightShiftReviewCard(deps({ reason: 'on-battery' }), WINDOW_KEY);
    expect(written).toEqual([]);
    expect(settledRecords().map((e) => (e.details as { windowKey: string }).windowKey)).toEqual([
      '2026-10-11',
      '2026-10-12',
      WINDOW_KEY,
    ]);

    // A night that ran since means the cause came back.
    events = [
      recordedNight('2026-10-11', daysBefore(2)),
      recordedNight('2026-10-12', daysBefore(1), true),
    ];
    await postNightShiftReviewCard(deps({ reason: 'on-battery' }), WINDOW_KEY);
    expect(newCards()).toHaveLength(1);
  });

  it('tells about a different reason than the last one', async () => {
    questions = [earlierCard('2026-10-12', { quiet: { reason: 'on-battery' } })];
    await postNightShiftReviewCard(deps({ reason: 'quota-held' }), WINDOW_KEY);
    expect(newCards()).toHaveLength(1);
    expect((newCards()[0]!.intent as NightShiftReviewIntent).quiet).toEqual({
      reason: 'quota-held',
    });
    expect(written.find((q) => q.id === 'card-2026-10-12')?.answer).toMatchObject({
      silentSkip: true,
    });
  });
});

describe('the first days', () => {
  it('holds a quiet night on a new install', async () => {
    await postNightShiftReviewCard(
      deps({ reason: 'on-battery', config: { firstUseAt: daysBefore(2) } }),
      WINDOW_KEY,
    );
    expect(written).toEqual([]);
    expect(settledRecords()).toHaveLength(1);
  });

  it('reports a quiet night once a new install is a few days old', async () => {
    await postNightShiftReviewCard(
      deps({ reason: 'on-battery', config: { firstUseAt: daysBefore(4) } }),
      WINDOW_KEY,
    );
    expect(newCards()).toHaveLength(1);
  });

  it('gives an upgraded install the same few days from the first night this build settled', async () => {
    vi.stubEnv('GEZEL_DISABLE_FIRST_USE_GRACE', '');
    // The first settle after the upgrade: nothing recorded yet.
    await postNightShiftReviewCard(deps({ reason: 'on-battery' }), WINDOW_KEY);
    expect(written).toEqual([]);
    expect(settledRecords()).toHaveLength(1);

    events = [recordedNight('2026-10-11', daysBefore(2))];
    await postNightShiftReviewCard(deps({ reason: 'on-battery' }), WINDOW_KEY);
    expect(written).toEqual([]);

    events = [recordedNight('2026-10-09', daysBefore(4))];
    await postNightShiftReviewCard(deps({ reason: 'on-battery' }), WINDOW_KEY);
    expect(newCards()).toHaveLength(1);
  });

  it('does not record the night before the home existed', async () => {
    await postNightShiftReviewCard(deps({ config: { firstUseAt: hoursBefore(0.5) } }), WINDOW_KEY);
    expect(written).toEqual([]);
    expect(settledRecords()).toEqual([]);
  });
});

describe('settling a night once', () => {
  it('does nothing when the window already has a card', async () => {
    questions = [earlierCard(WINDOW_KEY, { tasksCompleted: 1 })];
    night.tasksCompleted = [{ projectId: 'shop', ref: 'shop/2', title: 'Draft the brief' }];
    await postNightShiftReviewCard(deps(), WINDOW_KEY);
    expect(written).toEqual([]);
    expect(settledRecords()).toEqual([]);
  });

  it('does nothing when the night was already recorded without a card', async () => {
    events = [recordedNight(WINDOW_KEY, hoursBefore(1))];
    await postNightShiftReviewCard(deps({ reason: 'on-battery' }), WINDOW_KEY);
    expect(written).toEqual([]);
    expect(settledRecords()).toHaveLength(1);
  });
});
