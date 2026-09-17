import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  PR_REVIEW_PHASE_BUDGETS_MS,
  pullRequestReviewPhaseDiagnostics,
} from './pull-request-review-workflow.ts';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 17, 12, minutes)).toISOString();

function task(args: {
  num: number;
  createdAt: string;
  updatedAt: string;
  steps: TaskCraftbookStep[];
  parentTaskRef?: string;
}): Task {
  return {
    projectId: 'gezel',
    num: args.num,
    ref: `gezel/${args.num}`,
    title: `task ${args.num}`,
    status: 'complete',
    assignee: { kind: 'gezel', gezelId: 'koray' },
    craftbook: {
      id: 'pull-request-review',
      name: 'Pull Request Review',
      steps: args.steps,
      entryStepId: args.steps[0]!.id,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    },
    activeStepId: args.steps.at(-1)!.id,
    ...(args.parentTaskRef ? { parentTaskRef: args.parentTaskRef } : {}),
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
    createdBy: { kind: 'user' },
  };
}

describe('pull-request-review workflow diagnostics', () => {
  it('persists per-phase latency budgets and recognizes a recovered restart', () => {
    const host = task({
      num: 1,
      createdAt: at(0),
      updatedAt: at(40),
      steps: [
        { id: 'scope', name: 'scope', createdAt: at(0), completedAt: at(1) },
        { id: 'scan', name: 'scan', createdAt: at(1), completedAt: at(2) },
        {
          id: 'report',
          name: 'report',
          createdAt: at(30),
          lastActivatedAt: at(30),
          completedAt: at(38),
        },
      ],
    });
    const child = task({
      num: 2,
      parentTaskRef: host.ref,
      createdAt: at(2),
      updatedAt: at(28),
      steps: [
        {
          id: 'open-batch',
          name: 'open',
          createdAt: at(2),
          lastActivatedAt: at(2),
          completedAt: at(5),
          restartResumeCount: 1,
        },
        {
          id: 'review-batch',
          name: 'review',
          createdAt: at(5),
          lastActivatedAt: at(5),
          completedAt: at(28),
        },
      ],
    });

    const diagnostics = pullRequestReviewPhaseDiagnostics(host, [child]);
    expect(diagnostics.violations).toEqual([]);
    expect(diagnostics.phaseLatencies.childReviewBatch).toEqual({
      actualMs: 23 * 60_000,
      budgetMs: PR_REVIEW_PHASE_BUDGETS_MS.childReviewBatch,
      pass: true,
    });
    expect(diagnostics.restartRecovery).toEqual({
      resumedSteps: 1,
      taskRefs: ['gezel/2'],
      allCompleted: true,
    });
  });

  it('fails a spinning review phase independently of the overall timeout', () => {
    const host = task({
      num: 1,
      createdAt: at(0),
      updatedAt: at(89),
      steps: [
        { id: 'scan', name: 'scan', createdAt: at(0), completedAt: at(2) },
        {
          id: 'report',
          name: 'report',
          createdAt: at(80),
          completedAt: at(85),
        },
      ],
    });
    const child = task({
      num: 2,
      parentTaskRef: host.ref,
      createdAt: at(2),
      updatedAt: at(50),
      steps: [
        { id: 'open-batch', name: 'open', createdAt: at(2), completedAt: at(4) },
        { id: 'review-batch', name: 'review', createdAt: at(4), completedAt: at(40) },
      ],
    });

    const diagnostics = pullRequestReviewPhaseDiagnostics(host, [child]);
    expect(diagnostics.phaseLatencies.childReviewBatch.pass).toBe(false);
    expect(diagnostics.violations.join(' ')).toContain('childReviewBatch took 2160s');
  });
});
