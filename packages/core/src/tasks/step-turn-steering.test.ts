import { describe, expect, it } from 'vitest';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';
import type { ResolvedTuning } from '../tuning-resolve.js';
import { stepTurnSteering, tuningForStepAction } from './step-turn-steering.js';

const now = '2026-10-12T00:00:00.000Z';
const step = (s: Partial<TaskCraftbookStep> & { id: string }): TaskCraftbookStep =>
  ({ name: s.id, createdAt: now, ...s }) as TaskCraftbookStep;
const taskOf = (steps: TaskCraftbookStep[]) =>
  ({ executionMode: 'stepwise', craftbook: { steps } }) as unknown as Pick<
    Task,
    'executionMode' | 'craftbook'
  >;

describe('stepTurnSteering', () => {
  it('names the step, its deliverable, its last exit script and its inferred inputs', () => {
    const scope = step({
      id: 'scope',
      completedAt: now,
      advanceWhen: { file: 'tasks/3/scope.md', artifact: true },
    });
    const draft = step({
      id: 'draft',
      name: 'Draft the plan',
      prompt: 'Read scope.md, then write `plan.md`.',
      onExit: [{ name: 'tidy' }, { name: 'route' }],
      advanceWhen: { file: 'plan.md' },
    });
    const steering = stepTurnSteering(taskOf([scope, draft]), draft);
    expect(steering.activeStep).toEqual({
      name: 'Draft the plan',
      onExitScriptName: 'route',
      deliverableFile: 'plan.md',
      requiredInputs: [{ path: 'tasks/3/scope.md', artifact: true }],
    });
    expect(steering.workspaceDeliverable).toBe(true);
    expect(steering.terminalToolPolicy).toBeUndefined();
  });

  it('ends an artifact checkpoint step on the write of its own file', () => {
    const scope = step({
      id: 'scope',
      toolPolicy: { outputMedium: 'artifact' },
      advanceWhen: { file: 'tasks/3/billables.json', artifact: true },
      gate: {
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'tasks/3/scope.md', artifact: true, bytes: 1 }],
      },
    });
    const steering = stepTurnSteering(taskOf([scope]), scope);
    expect(steering.workspaceDeliverable).toBe(false);
    expect(steering.action).toBe('checkpoint');
    expect(steering.terminalToolPolicy).toEqual({
      toolNames: ['write_artifact'],
      fallbackText: 'Checkpoint written for validation.',
      maxClosingChars: 120,
      onlyWhenArgEquals: { arg: 'path', value: 'tasks/3/billables.json' },
    });
  });

  it('turns an evidence-only read into one compact required call', () => {
    const read = step({
      id: 'read',
      toolPolicy: { outputMedium: 'none', allowTools: ['read_artifact'] },
      gate: {
        at: 'completion',
        checks: [{ kind: 'artifactReadEvidence', paths: 'tasks/3/inputs/source.json' }],
      },
    });
    const steering = stepTurnSteering(taskOf([read]), read);
    expect(steering.action).toBe('evidence');
    expect(steering.terminalToolPolicy?.toolNames).toEqual(['read_artifact']);
    const tuning = {
      sampling: { maxTokens: 4096, temperature: 0.7 },
      reasoning: { enableThinking: true, thinkingBudget: 2048 },
    } as unknown as ResolvedTuning;
    expect(tuningForStepAction(tuning, 'evidence')).toMatchObject({
      sampling: { maxTokens: 512, temperature: 0.7 },
      reasoning: { enableThinking: false, thinkingBudget: undefined },
      toolChoice: 'required',
    });
    expect(tuningForStepAction(tuning, 'checkpoint')).toEqual({
      ...tuning,
      toolChoice: 'required',
    });
  });
});
