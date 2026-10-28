import { describe, expect, it } from 'vitest';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';
import { STAGE_DURATION_SEEDS } from './duration-seeds.js';
import { estimateRemaining, remainingText, stepDurationEstimates } from './eta.js';

const T0 = Date.parse('2026-10-23T09:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** scope → draft → evaluate → finish, each step working the given minutes. */
function run(minutes: [number, number, number, number] | null, over: Partial<Task> = {}): Task {
  let clock = 0;
  const ids = ['scope', 'draft', 'evaluate', 'finish'];
  const steps = ids.map((id, i) => {
    const start = clock;
    if (minutes) clock += minutes[i]!;
    return {
      id,
      name: id,
      createdAt: at(0),
      ...(i === ids.length - 1 ? { terminal: true } : { next: ids[i + 1] }),
      ...(minutes
        ? { lastActivatedAt: at(start), completedAt: at(clock), workMs: minutes[i]! * 60_000 }
        : {}),
    } as TaskCraftbookStep;
  });
  return {
    projectId: 'shop',
    num: 1,
    ref: 'shop/1',
    title: 'Invoices',
    status: minutes ? 'complete' : 'active',
    createdAt: at(0),
    ...(minutes ? { workMs: clock * 60_000, workedThrough: at(clock) } : {}),
    sourceCraftbookIds: [{ role: 'main', catalogId: 'invoice-run' }],
    craftbook: { id: 'invoice-run', name: 'Invoice run', steps, entryStepId: 'scope' },
    ...over,
  } as unknown as Task;
}

describe('stepDurationEstimates', () => {
  it('takes medians per book, per step and per stage, split by engine', () => {
    const tasks = [run([1, 4, 2, 1]), run([3, 8, 2, 1]), run([2, 6, 4, 1])];
    const est = stepDurationEstimates(tasks, {
      engineOf: (t) => (t === tasks[0] ? 'cloud' : 'device'),
    });
    // runs of 8, 14 and 13 minutes
    expect(est.books['invoice-run']).toBe(13 * 60_000);
    expect(est.steps.get('any|invoice-run:draft')).toBe(6 * 60_000);
    expect(est.steps.get('device|invoice-run:draft')).toBe(7 * 60_000);
    expect(est.steps.get('cloud|invoice-run:draft')).toBe(4 * 60_000);
    // evaluate and finish both check: 2,2,4,1,1,1
    expect(est.stages.get('any|check')).toBe(1.5 * 60_000);
  });

  it('leaves out overnight, recurring and fanout runs, and unfinished ones', () => {
    const est = stepDurationEstimates([
      run([1, 4, 2, 1], { nightShift: { enabled: true } }),
      run([1, 4, 2, 1], { parentTaskRef: 'shop/0' }),
      run(null),
    ]);
    expect(est.books).toEqual({});
    expect(est.stages.size).toBe(0);
  });

  it('counts work time, never the days a run sat paused or the laptop was closed', () => {
    const slept = run([1, 4, 2, 1]);
    slept.craftbook.steps[3]!.completedAt = at(3 * 24 * 60);
    const legacy = run([1, 4, 2, 1], { workMs: undefined, workedThrough: undefined });
    const est = stepDurationEstimates([slept, legacy]);
    expect(est.books['invoice-run']).toBe(8 * 60_000);
    expect(est.steps.get('any|invoice-run:finish')).toBe(60_000);
  });
});

describe('estimateRemaining', () => {
  const history = stepDurationEstimates([run([1, 4, 2, 1]), run([3, 8, 2, 1])]);

  it("adds what is left of the active step to the rest of the book's path", () => {
    const live = run(null, { activeStepId: 'draft' });
    live.craftbook.steps[1]!.lastActivatedAt = at(10);
    const est = estimateRemaining(live, history, { now: T0 + 12 * 60_000 });
    // draft median 6 → 4 left; evaluate 2; finish 1
    expect(est).toEqual({ remainingMs: 7 * 60_000, firstTime: false, overdue: false });
    expect(remainingText(est!)).toBe('About 7 minutes left');
  });

  it('says it is a guess on a first run, from the stage seeds', () => {
    const live = run(null, {
      activeStepId: 'evaluate',
      sourceCraftbookIds: [{ role: 'main', catalogId: 'new-book' }],
    });
    live.craftbook.steps[2]!.lastActivatedAt = at(0);
    const est = estimateRemaining(live, stepDurationEstimates([]), { now: T0, engine: 'cloud' });
    expect(est?.firstTime).toBe(true);
    expect(est?.remainingMs).toBe(STAGE_DURATION_SEEDS.cloud.check * 2);
    expect(remainingText(est!)).toBe('First time here: about 2 minutes');
  });

  it('calls a step overdue past half again its time and three minutes more', () => {
    const live = run(null, { activeStepId: 'draft' });
    live.craftbook.steps[1]!.lastActivatedAt = at(0);
    const onTime = estimateRemaining(live, history, { now: T0 + 9 * 60_000 });
    const late = estimateRemaining(live, history, { now: T0 + 9.5 * 60_000 });
    expect(onTime?.overdue).toBe(false);
    expect(late?.overdue).toBe(true);
    expect(remainingText(late!)).toBe('Taking longer than usual');
  });

  it('measures the step under way by its work, so a nap does not make it late', () => {
    const live = run(null, { activeStepId: 'draft', status: 'paused', workMs: 3 * 60_000 });
    live.craftbook.steps[1]!.lastActivatedAt = at(1);
    live.craftbook.steps[1]!.workMs = 2 * 60_000;
    const est = estimateRemaining(live, history, { now: T0 + 3 * 24 * 60 * 60_000 });
    // draft median 6 → 4 left; evaluate 2; finish 1
    expect(est).toEqual({ remainingMs: 7 * 60_000, firstTime: false, overdue: false });
  });

  it('has nothing to say without an active step', () => {
    expect(estimateRemaining(run([1, 1, 1, 1]), history, { now: T0 })).toBeNull();
  });
});
