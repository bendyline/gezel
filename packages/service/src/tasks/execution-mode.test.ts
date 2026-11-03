import type { CraftbookContract, TaskCraftbook } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type ExecutionModeResolution, applyExecutionMode } from './execution-mode.js';

const NOW = '2026-11-01T10:00:00.000Z';

const CONTRACT: CraftbookContract = {
  goal: 'A cited report on the brief.',
  deliverables: [
    { id: 'report', path: 'out/report.md', kind: 'markdown-report', description: 'The report' },
  ],
  criteria: [
    {
      id: 'substantial',
      kind: 'acceptance',
      text: 'The report is substantial',
      checks: [{ kind: 'minBytes', file: 'out/report.md', bytes: 400 }],
    },
  ],
};

function book(overrides: Partial<TaskCraftbook> = {}): TaskCraftbook {
  return {
    id: 'research-report',
    name: 'Research report',
    entryStepId: 'draft',
    contract: CONTRACT,
    steps: [
      {
        id: 'draft',
        name: 'Draft',
        prompt: 'Write out/report.md.',
        suggestedRole: 'writer',
        advanceWhen: { file: 'out/report.md', minBytes: 400 },
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

const resolveTo = (resolution: ExecutionModeResolution) => async () => resolution;

describe('applyExecutionMode', () => {
  it("renders a model's outcome pick with the options it carries", async () => {
    const applied = await applyExecutionMode(
      resolveTo({
        mode: 'generalist',
        strategy: 'outcome',
        options: { procedure: 'none' },
        fallback: 'stepwise',
        source: 'model',
        ownerGezelId: 'g-generalist',
      }),
      { projectId: 'p', ref: 'p/1', craftbook: book(), requested: 'auto', now: NOW },
    );
    expect(applied.strategy).toBe('outcome');
    expect(applied.strategyOptions).toEqual({ procedure: 'none' });
    expect(applied.craftbook.renderedAs).toBe('outcome');
    expect(applied.craftbook.steps[0]!.prompt).not.toContain('Recommended approach');
    expect(applied.craftbook.steps[0]!.assignee).toEqual({
      kind: 'gezel',
      gezelId: 'g-generalist',
    });
  });

  it("lays the request's options over the pick's", async () => {
    const applied = await applyExecutionMode(
      resolveTo({ mode: 'generalist', strategy: 'outcome', options: { procedure: 'none' } }),
      {
        projectId: 'p',
        ref: 'p/1',
        craftbook: book(),
        requested: 'outcome',
        explicit: true,
        strategyOptions: { contract: 'hidden' },
        now: NOW,
      },
    );
    expect(applied.strategyOptions).toEqual({ procedure: 'none', contract: 'hidden' });
    expect(applied.craftbook.steps[0]!.gate).toBeUndefined();
  });

  it("falls back to the model's next choice when its outcome pick cannot render", async () => {
    const applied = await applyExecutionMode(
      resolveTo({
        mode: 'generalist',
        strategy: 'outcome',
        options: { procedure: 'none' },
        fallback: 'stepwise',
        source: 'model',
        ownerGezelId: 'g-generalist',
      }),
      {
        projectId: 'p',
        ref: 'p/1',
        craftbook: book({ contract: undefined }),
        requested: 'auto',
        now: NOW,
      },
    );
    expect(applied.strategy).toBe('stepwise');
    expect(applied.mode).toBe('stepwise');
    expect(applied.strategyOptions).toBeUndefined();
    expect(applied.craftbook.steps.every((s) => s.assignee === undefined)).toBe(true);
  });

  it('still refuses an explicit outcome request a book cannot run', async () => {
    await expect(
      applyExecutionMode(resolveTo({ mode: 'generalist', strategy: 'outcome' }), {
        projectId: 'p',
        ref: 'p/1',
        craftbook: book({ contract: undefined }),
        requested: 'outcome',
        explicit: true,
        now: NOW,
      }),
    ).rejects.toThrow(/cannot run as an outcome/);
  });

  it('leaves the terminal contract gate off when the contract is not enforced', async () => {
    const enforced = await applyExecutionMode(resolveTo({ mode: 'stepwise' }), {
      projectId: 'p',
      ref: 'p/1',
      craftbook: book(),
      requested: 'stepwise',
      explicit: true,
      now: NOW,
    });
    expect(enforced.craftbook.steps.at(-1)!.gate).toBeDefined();
    const shown = await applyExecutionMode(resolveTo({ mode: 'stepwise' }), {
      projectId: 'p',
      ref: 'p/1',
      craftbook: book(),
      requested: 'stepwise',
      explicit: true,
      strategyOptions: { contract: 'shown' },
      now: NOW,
    });
    expect(shown.craftbook.steps.at(-1)!.gate).toBeUndefined();
    expect(shown.strategyOptions).toEqual({ contract: 'shown' });
  });
});
