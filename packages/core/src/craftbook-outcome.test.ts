import { describe, expect, it } from 'vitest';
import {
  OUTCOME_STEP_ID,
  contractChecksForTask,
  outcomeRenderGap,
  renderCraftbookAsOutcome,
  withTerminalContractGate,
} from './craftbook-outcome.js';
import type { CraftbookContract } from './schemas/craftbook-contract.js';
import { normalizeStepGate } from './schemas/gate.js';
import type { TaskCraftbook } from './schemas/task.js';
import {
  requestedTaskStrategy,
  resolveTaskStrategy,
  strategyProfile,
  taskSurfaceSteps,
} from './task-strategy.js';

const NOW = '2026-10-22T10:00:00.000Z';

const CONTRACT: CraftbookContract = {
  goal: 'A cited report on the brief.',
  inputs: [{ path: 'source/brief.md', required: true }],
  deliverables: [
    { id: 'report', path: 'out/report.md', kind: 'markdown-report', description: 'The report' },
  ],
  grounding: { sources: ['source/brief.md'], citationStyle: 'inline-path' },
  criteria: [
    {
      id: 'read',
      kind: 'acceptance',
      text: 'The brief was read',
      checks: [
        {
          kind: 'researchEvidence',
          sourcePath: 'source/brief.md',
          tools: ['web_search'],
          minSuccessful: 1,
        },
      ],
    },
    {
      id: 'grounded',
      kind: 'quality',
      text: 'Every figure is in the brief',
      checks: [{ kind: 'claimsGrounded', file: 'out/report.md' }],
    },
    {
      id: 'tone',
      kind: 'quality',
      enforce: 'eval-only',
      text: 'Reads well',
      judge: { rubric: 'Does it read well?' },
    },
  ],
};

function book(overrides: Partial<TaskCraftbook> = {}): TaskCraftbook {
  return {
    id: 'research-report',
    name: 'Research report',
    entryStepId: 'scope',
    contract: CONTRACT,
    steps: [
      {
        id: 'scope',
        name: 'Scope',
        prompt: 'Read `source/brief.md` and write outline.md.',
        suggestedRole: 'researcher',
        consumes: [{ file: 'source/brief.md' }],
        createdAt: NOW,
        next: 'draft',
      },
      {
        id: 'draft',
        name: 'Draft',
        prompt: 'Write out/report.md from the outline. Then call advance_task_step.',
        suggestedRole: 'writer',
        authoring: 'squisq',
        advanceWhen: { file: 'out/report.md', minBytes: 400 },
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'out/report.md', bytes: 400 }],
          maxAttempts: 6,
        },
        createdAt: NOW,
        next: 'evaluate',
      },
      {
        id: 'evaluate',
        name: 'Evaluate',
        prompt: 'Check the report against the outline.',
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'out/report.md', bytes: 400 }],
          onReject: 'draft',
          maxAttempts: 4,
        },
        createdAt: NOW,
        next: 'finish',
      },
      { id: 'finish', name: 'Finish', prompt: 'Summarize.', terminal: true, createdAt: NOW },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('resolveTaskStrategy', () => {
  it('lets taskStrategy outrank generalistMode, and keeps auto exactly as before', () => {
    expect(resolveTaskStrategy({ taskStrategy: 'outcome', generalistMode: 'off' }, 'mlx')).toBe(
      'outcome',
    );
    expect(resolveTaskStrategy({ taskStrategy: 'auto', generalistMode: 'on' }, 'mlx')).toBe(
      'generalist',
    );
    expect(resolveTaskStrategy({}, 'anthropic')).toBe('generalist');
    expect(resolveTaskStrategy({}, 'llama-cpp', 'medium')).toBe('stepwise');
  });

  it('reads a task request: strategy, then execution mode, then the install', () => {
    expect(requestedTaskStrategy({ strategy: 'outcome', executionMode: 'stepwise' })).toBe(
      'outcome',
    );
    expect(requestedTaskStrategy({ strategy: 'auto', executionMode: 'stepwise' })).toBe('stepwise');
    expect(requestedTaskStrategy({})).toBe('auto');
  });

  it('describes what each strategy imposes', () => {
    expect(strategyProfile('stepwise').procedure).toBe('enforced');
    expect(strategyProfile('outcome', { procedure: 'none', subagents: false })).toMatchObject({
      session: 'single',
      procedure: 'none',
      stepGates: false,
      subagents: false,
    });
  });
});

describe('renderCraftbookAsOutcome', () => {
  it('folds the recipe into one terminal step gated by the contract', () => {
    const rendered = renderCraftbookAsOutcome(book(), { now: NOW });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const cb = rendered.craftbook;
    expect(cb.renderedAs).toBe('outcome');
    expect(cb.entryStepId).toBe(OUTCOME_STEP_ID);
    expect(cb.steps).toHaveLength(1);
    const step = cb.steps[0]!;
    expect(step.terminal).toBe(true);
    expect(step.consumes).toEqual([{ file: 'source/brief.md' }]);
    expect(step.authoring).toBe('squisq');
    expect(step.advanceWhen).toEqual({ file: 'out/report.md', minBytes: 400 });
    const gate = normalizeStepGate(step.gate!);
    expect(gate.at).toBe('completion');
    expect(gate.onReject).toBeUndefined();
    expect(gate.maxAttempts).toBe(4);
    expect(gate.checks).toEqual(contractChecksForTask(CONTRACT));
    expect(gate.checks[0]).toMatchObject({ kind: 'researchEvidence', window: 'task' });
    expect(step.prompt).toContain('Recommended approach (advisory)');
    expect(step.prompt).toContain('##### 2. Draft');
    expect(taskSurfaceSteps(cb).map((s) => s.id)).toEqual(['scope', 'draft', 'evaluate', 'finish']);
  });

  it('leaves the recipe out when asked to', () => {
    const rendered = renderCraftbookAsOutcome(book(), {
      now: NOW,
      options: { procedure: 'none', subagents: false },
    });
    expect(rendered.ok && rendered.craftbook.steps[0]!.prompt).not.toContain('Recommended');
    expect(rendered.ok && rendered.craftbook.steps[0]!.prompt).not.toContain('consult_');
  });

  it('does a fanout inline and keeps the template steps for the tool surface', () => {
    const host = book({
      spawn: {
        overFile: 'items.json',
        steps: [{ id: 'one', name: 'One item', prompt: 'Write out/{{slug}}.md' }],
      },
    });
    host.steps[1] = { ...host.steps[1]!, spawnFanout: true };
    const spawns: TaskCraftbook = {
      id: 'child',
      name: 'Child',
      entryStepId: 'one',
      steps: [
        {
          id: 'one',
          name: 'One item',
          prompt: 'Write out/{{slug}}.md',
          createdAt: NOW,
          terminal: true,
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const rendered = renderCraftbookAsOutcome(host, { spawnsCraftbook: spawns, now: NOW });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.craftbook.spawn).toBeUndefined();
    expect(rendered.craftbook.steps[0]!.prompt).toContain('For each item in `items.json`');
    expect(rendered.craftbook.sourceSteps?.map((s) => s.id)).toContain('each-one');
  });

  it('refuses books whose order the render would lose, and books with no contract', () => {
    expect(outcomeRenderGap(book({ contract: undefined }))).toMatch(/no contract/);
    const owner = book();
    owner.steps[2] = { ...owner.steps[2]!, assignee: { kind: 'user' } };
    expect(outcomeRenderGap(owner)).toMatch(/done by the person/);
    const branching = book();
    branching.steps[1] = {
      ...branching.steps[1]!,
      branches: [{ when: { op: 'ok' }, goto: 'finish' }],
    };
    expect(outcomeRenderGap(branching)).toMatch(/routes on a script result/);
    const late = book();
    late.steps[2] = { ...late.steps[2]!, onEnter: { name: 'prepare' } };
    expect(outcomeRenderGap(late)).toMatch(/runs a script when it starts/);
    const entryHook = book();
    entryHook.steps[0] = { ...entryHook.steps[0]!, onEnter: { name: 'prepare' } };
    expect(outcomeRenderGap(entryHook)).toBeNull();
  });
});

describe('withTerminalContractGate', () => {
  it('gates the terminal step on the contract and loops back to the producer', () => {
    const gated = withTerminalContractGate(book());
    const finish = gated.steps.find((s) => s.id === 'finish')!;
    const gate = normalizeStepGate(finish.gate!);
    expect(gate.at).toBe('completion');
    expect(gate.onReject).toBe('draft');
    expect(gate.checks).toEqual(contractChecksForTask(CONTRACT));
    expect(withTerminalContractGate(gated)).toBe(gated);
  });

  it('appends to an existing completion gate and keeps its routing', () => {
    const b = book();
    b.steps[3] = {
      ...b.steps[3]!,
      gate: {
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'out/summary.md', bytes: 10 }],
        onReject: 'evaluate',
      },
    };
    const gate = normalizeStepGate(withTerminalContractGate(b).steps[3]!.gate!);
    expect(gate.onReject).toBe('evaluate');
    expect(gate.checks.map((c) => c.kind)).toEqual([
      'minBytes',
      'researchEvidence',
      'claimsGrounded',
    ]);
  });

  it('leaves an escalation exit the recipe only jumps to alone', () => {
    const b = book();
    b.steps.push({ id: 'needs-user', name: 'Needs user', terminal: true, createdAt: NOW });
    const gated = withTerminalContractGate(b);
    expect(gated.steps.find((s) => s.id === 'finish')!.gate).toBeDefined();
    expect(gated.steps.find((s) => s.id === 'needs-user')!.gate).toBeUndefined();
  });

  it('leaves a person’s terminal step and a book without a contract alone', () => {
    const b = book();
    b.steps[3] = { ...b.steps[3]!, assignee: { kind: 'user' } };
    expect(withTerminalContractGate(b).steps[3]!.gate).toBeUndefined();
    const plain = book({ contract: undefined });
    expect(withTerminalContractGate(plain)).toBe(plain);
  });
});
