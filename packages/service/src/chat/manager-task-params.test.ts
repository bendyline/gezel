import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type BuildInstructionsOptions,
  type PromptTaskContext,
  buildInstructions,
} from './instructions.js';

const NOW = '2026-08-06T00:00:00.000Z';

function powerpointTask(params?: Record<string, string>): PromptTaskContext {
  const step: TaskCraftbookStep = {
    id: 'outline',
    name: 'Outline the deck',
    prompt: 'Read the named source content and write notes/outline.md.',
    suggestedRole: 'planner',
    next: 'write',
    createdAt: NOW,
  };
  const task: Task = {
    projectId: 'default',
    num: 3,
    ref: 'default/3',
    title: 'PowerPoint from Content',
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'guadalupe' },
    craftbook: {
      id: 'powerpoint-deck',
      name: 'PowerPoint from Content',
      steps: [step],
      entryStepId: step.id,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...(params ? { craftbookParams: params } : {}),
    activeStepId: step.id,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: { kind: 'gezel', gezelId: 'wren' },
  };
  return { task, step };
}

function render(task: PromptTaskContext): string {
  return buildInstructions({
    name: 'Guadalupe',
    role: 'planner',
    about: 'Plan the work before production.',
    task,
    recallBlock:
      '\n\n### Recalled from prior sessions\n\n- [workspace] `artifacts/night-shift-report.md`',
    availableTools: [
      { name: 'read_file', description: 'Read a workspace file.' },
      { name: 'write_file', description: 'Write a workspace file.' },
      { name: 'write_task_note', description: 'Append a task note.' },
    ],
  } as BuildInstructionsOptions).full;
}

describe('buildInstructions — craftbook invocation parameters', () => {
  it('surfaces inline source inputs ahead of unrelated recalled workspace context', () => {
    const prompt = render(
      powerpointTask({
        outputPath: 'finland-presentation.pptx',
        topic: 'Finland',
        content:
          'A comprehensive overview of Finland covering geography, culture, history, economy, innovation, nature, and daily life.',
      }),
    );

    expect(prompt).toContain('### Invocation parameters');
    expect(prompt).toContain('authoritative task inputs');
    expect(prompt).toContain('`topic`: "Finland"');
    expect(prompt).toContain('`content`: "A comprehensive overview of Finland');
    expect(prompt).toContain('`outputPath`: "finland-presentation.pptx"');
    expect(prompt.indexOf('### Invocation parameters')).toBeLessThan(
      prompt.indexOf('### Recalled from prior sessions'),
    );
  });

  it('omits the invocation block for ordinary tasks without parameters', () => {
    expect(render(powerpointTask())).not.toContain('### Invocation parameters');
  });
});
