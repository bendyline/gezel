import type { ProjectDetail, Task, TaskCraftbookStep } from '@bendyline/gezel';
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

describe('buildInstructions — focused craftbook steps', () => {
  const focusedPrompt = (layeredPrefixCache = false) => {
    const task = powerpointTask({ content: 'Exact batch records: record-1.md, record-2.md' });
    if (!task.step) throw new Error('fixture step missing');
    task.step.promptProfile = 'focused';
    return buildInstructions({
      name: 'Koray',
      role: 'Reviewer',
      about: 'PROJECT-IRRELEVANT-ABOUT '.repeat(100),
      project: {
        id: 'gezel',
        name: 'Gezel',
        about: 'PROJECT-GUIDE-SHOULD-BE-OMITTED '.repeat(100),
        missionObjectives: 'MISSION-SHOULD-BE-OMITTED',
      } as unknown as ProjectDetail,
      workspaceFiles: [
        {
          name: 'manager.ts',
          path: 'packages/service/src/chat/manager.ts',
          isDirectory: false,
        },
      ],
      documentFiles: [{ name: 'house-style.md', path: 'house-style.md', isDirectory: false }],
      recallBlock: '\n\nRECALL-SHOULD-BE-OMITTED',
      task,
      layeredPrefixCache,
      availableTools: [
        { name: 'read_artifact', description: 'Read an artifact.' },
        { name: 'write_artifact', description: 'Write an artifact.' },
      ],
      focusedTaskContext: true,
    } as BuildInstructionsOptions);
  };

  it('keeps the exact step procedure and truthful tools while dropping standing project context', () => {
    const rendered = focusedPrompt();
    expect(rendered.full).toContain('Your role is "Reviewer".');
    expect(rendered.full).toContain('#### Step procedure');
    expect(rendered.full).toContain('Exact batch records: record-1.md, record-2.md');
    expect(rendered.full).toContain('`read_artifact`');
    expect(rendered.full).not.toContain('PROJECT-IRRELEVANT-ABOUT');
    expect(rendered.full).not.toContain('PROJECT-GUIDE-SHOULD-BE-OMITTED');
    expect(rendered.full).not.toContain('MISSION-SHOULD-BE-OMITTED');
    expect(rendered.full).not.toContain('RECALL-SHOULD-BE-OMITTED');
    expect(rendered.full).not.toContain('### Workspace files');
    expect(rendered.full).not.toContain('house-style.md');
  });

  it('keeps task-specific context in the volatile layer when layered caching is active', () => {
    const rendered = focusedPrompt(true);
    expect(rendered.full).not.toContain('Exact batch records');
    expect(rendered.volatileContext).toContain('Exact batch records: record-1.md, record-2.md');
    expect(rendered.layers?.project).toBe(rendered.full);
  });
});
