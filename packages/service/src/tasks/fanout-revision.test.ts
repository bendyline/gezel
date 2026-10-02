import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  buildRevisionNote,
  carryFanoutLoopGateAttempts,
  classifyFanoutActivation,
  currentRoundChildren,
} from './fanout-revision.js';

const T0 = '2026-10-01T14:28:42.000Z'; // draft's first activation; crew spawned
const T1 = '2026-10-01T14:38:01.949Z'; // evaluate rejects
const T2 = '2026-10-01T14:38:01.952Z'; // gate loops back into draft

const evaluateGate = {
  at: 'completion' as const,
  checks: [
    {
      kind: 'notContains' as const,
      file: 'tasks/1/verdict.md',
      pattern: '\\bFAIL\\s*$',
      flags: 'm',
      label: 'no criterion line ends in FAIL',
      artifact: true,
    },
  ],
  onReject: 'draft',
  maxAttempts: 3,
};

function step(partial: Partial<TaskCraftbookStep> & { id: string }): TaskCraftbookStep {
  return { name: partial.id, ...partial } as TaskCraftbookStep;
}

function host(steps: TaskCraftbookStep[]): Task {
  return {
    projectId: 'office',
    num: 1,
    ref: 'office/1',
    title: 'Monthly Invoice Run',
    status: 'active',
    assignee: { kind: 'user' },
    activeStepId: 'draft',
    spawnsCraftbook: { id: 'spawn', name: 'spawn', entryStepId: 'draft-invoice', steps: [] },
    craftbook: {
      id: 'invoice-run',
      name: 'Monthly Invoice Run',
      entryStepId: 'scope',
      steps,
      spawn: { overFile: 'tasks/1/billables.json', overArtifact: true, steps: [] },
    },
    createdAt: T0,
    updatedAt: T2,
    createdBy: { kind: 'user' },
  } as unknown as Task;
}

function child(num: number, createdAt: string, status: Task['status']): Task {
  return { ref: `office/${num}`, num, createdAt, status, parentTaskRef: 'office/1' } as Task;
}

const rejectedEvaluate = step({
  id: 'evaluate',
  name: 'Evaluate',
  gate: evaluateGate,
  gateAttempts: 1,
  lastGateReject: { message: 'tasks/1/verdict.md contains forbidden content', at: T1 } as never,
  gateAttemptHistory: [
    {
      at: T1,
      attempt: 1,
      signatureHash: 'sig',
      messageFingerprint: 'fp',
      failedChecks: ['no criterion line ends in FAIL'],
    },
  ],
});
const loopedDraft = step({
  id: 'draft',
  name: 'Draft the invoices',
  spawnFanout: true,
  lastActivatedAt: T2,
});

describe('classifyFanoutActivation', () => {
  it('fans out the first time', () => {
    const fresh = step({ id: 'draft', spawnFanout: true, lastActivatedAt: T0 });
    expect(classifyFanoutActivation(host([fresh]), fresh, [])).toEqual({ kind: 'first' });
  });

  it('runs a revision pass when the gate looped back after the crew settled', () => {
    const task = host([loopedDraft, rejectedEvaluate]);
    const crew = [child(2, T0, 'complete'), child(3, T0, 'canceled')];
    const activation = classifyFanoutActivation(task, loopedDraft, crew);
    expect(activation).toMatchObject({ kind: 'revise', pass: 2 });
    if (activation.kind === 'revise') expect(activation.gatedStep.id).toBe('evaluate');
  });

  it('never double-spawns', () => {
    const task = host([loopedDraft, rejectedEvaluate]);
    // A re-fire of the same activation (barrier release, duplicate hook).
    expect(
      classifyFanoutActivation(task, loopedDraft, [
        child(2, T0, 'complete'),
        child(4, T2, 'active'),
      ]).kind,
    ).toBe('skip');
    // An earlier crew still drafting: the post-fanout barrier waits on it.
    for (const status of ['active', 'paused'] as const) {
      expect(classifyFanoutActivation(task, loopedDraft, [child(2, T0, status)]).kind).toBe('skip');
    }
  });

  it("keeps today's advance-through for re-activations that are not a gate loop", () => {
    const crew = [child(2, T0, 'complete')];
    // A user re-activation: no gate rejection since the crew was spawned.
    const passed = step({ id: 'evaluate', gate: evaluateGate });
    expect(classifyFanoutActivation(host([loopedDraft, passed]), loopedDraft, crew).kind).toBe(
      'skip',
    );
    // A rejection older than the crew belongs to an earlier round.
    const old = step({
      id: 'evaluate',
      gate: evaluateGate,
      gateAttempts: 1,
      lastGateReject: { message: 'x', at: '2026-10-01T14:00:00.000Z' } as never,
    });
    expect(classifyFanoutActivation(host([loopedDraft, old]), loopedDraft, crew).kind).toBe('skip');
    // A gate that routes somewhere else did not send the work here.
    const elsewhere = step({ ...rejectedEvaluate, gate: { ...evaluateGate, onReject: 'collect' } });
    expect(classifyFanoutActivation(host([loopedDraft, elsewhere]), loopedDraft, crew).kind).toBe(
      'skip',
    );
    // A legacy step with no activation stamp cannot tell rounds apart.
    const legacy = step({ id: 'draft', spawnFanout: true });
    expect(classifyFanoutActivation(host([legacy, rejectedEvaluate]), legacy, crew).kind).toBe(
      'skip',
    );
  });

  it('numbers the pass from the gate attempts', () => {
    const second = step({ ...rejectedEvaluate, gateAttempts: 2 });
    const activation = classifyFanoutActivation(host([loopedDraft, second]), loopedDraft, [
      child(2, T0, 'complete'),
    ]);
    expect(activation).toMatchObject({ kind: 'revise', pass: 3 });
  });
});

describe('currentRoundChildren', () => {
  it("keeps only the children spawned under the step's current activation", () => {
    const crew = [child(2, T0, 'complete'), child(5, T2, 'active')];
    expect(currentRoundChildren(crew, loopedDraft).map((c) => c.num)).toEqual([5]);
    expect(currentRoundChildren(crew, step({ id: 'draft' }))).toHaveLength(2);
  });
});

describe('buildRevisionNote', () => {
  const findings =
    'One invoice per billable client. PASS\nEvery amount traces to a ledger entry. FAIL\n  2026-043 bills 2,060.00; the ledger says 2,600.00';

  it("carries the review's findings and the failed checks, not the gate's orders", () => {
    const note = buildRevisionNote({
      fanoutStep: loopedDraft,
      gatedStep: step({
        ...rejectedEvaluate,
        advanceWhen: { file: 'tasks/1/verdict.md', artifact: true },
      }),
      pass: 2,
      findings,
    });
    expect(note).toContain('# Revision pass 2 — the review sent this work back');
    expect(note).toContain('"Evaluate" did not pass the run');
    expect(note).toContain('"Draft the invoices"');
    expect(note).toContain('Checks that failed: no criterion line ends in FAIL.');
    expect(note).toContain('## What the review found (tasks/1/verdict.md)');
    expect(note).toContain('2026-043 bills 2,060.00; the ledger says 2,600.00');
    expect(note).toContain('If the review names nothing about this item');
    // The gate message is an order to the reviewer; a child must not obey it.
    expect(note).not.toContain('contains forbidden content');
  });

  it('caps a long findings file and survives a missing one', () => {
    const long = buildRevisionNote({
      fanoutStep: loopedDraft,
      gatedStep: rejectedEvaluate,
      pass: 3,
      findings: 'x'.repeat(10_000),
    });
    expect(long.length).toBeLessThan(4_000);
    expect(long).toContain('… (truncated)');
    const none = buildRevisionNote({
      fanoutStep: loopedDraft,
      gatedStep: rejectedEvaluate,
      pass: 2,
      findings: null,
    });
    expect(none).not.toContain('What the review found');
    expect(none).toContain('Checks that failed');
  });
});

describe('carryFanoutLoopGateAttempts', () => {
  const steps = [loopedDraft, rejectedEvaluate];
  const bumped = steps.map((s) =>
    s.id === 'evaluate' ? step({ id: 'evaluate', gate: evaluateGate }) : s,
  );

  it('keeps the attempt count when re-entering a gate whose rejections fan back out', () => {
    const after = carryFanoutLoopGateAttempts(host(steps), steps, bumped, 'evaluate');
    const evaluate = after.find((s) => s.id === 'evaluate')!;
    expect(evaluate.gateAttempts).toBe(1);
    // Only the count carries: the new pass is judged afresh.
    expect(evaluate.lastGateReject).toBeUndefined();
  });

  it('leaves ordinary upstream loops, settled gates, and non-hosts with a clean budget', () => {
    const plain = steps.map((s) => (s.id === 'draft' ? step({ id: 'draft' }) : s));
    expect(
      carryFanoutLoopGateAttempts(host(plain), plain, bumped, 'evaluate').find(
        (s) => s.id === 'evaluate',
      )!.gateAttempts,
    ).toBeUndefined();
    const passed = [loopedDraft, step({ ...rejectedEvaluate, completedAt: T2 })];
    expect(carryFanoutLoopGateAttempts(host(passed), passed, bumped, 'evaluate')).toBe(bumped);
    const notHost = { ...host(steps), spawnsCraftbook: undefined } as unknown as Task;
    expect(carryFanoutLoopGateAttempts(notHost, steps, bumped, 'evaluate')).toBe(bumped);
  });
});
