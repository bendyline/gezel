import type { ChatSession, Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type TaskOutputStore,
  WRAP_UP_MAX_FILES,
  collectTaskOutputs,
  composeTaskWrapUp,
  resolveTaskDeliverable,
  taskFinishedQuestion,
  wantsWrapUp,
} from './completion-wrapup.js';

const task = (over: Partial<Task> = {}): Task =>
  ({
    projectId: 'default',
    num: 2,
    ref: 'default/2',
    title: 'Weekly posts and catering quote',
    status: 'complete',
    launchSessionId: 'meester-thread',
    ...over,
  }) as Task;

function session(
  calls: Array<{ name: string; path?: string; success?: boolean; at: string }>,
): ChatSession {
  return {
    id: 's1',
    gezelId: 'kylian',
    projectId: 'default',
    taskRef: 'default/2',
    messages: [
      {
        role: 'assistant',
        content: '',
        at: '2026-09-28T10:00:00.000Z',
        toolCalls: calls.map((c) => ({
          name: c.name,
          at: c.at,
          durationMs: 1,
          success: c.success ?? true,
          ...(c.path ? { path: c.path } : {}),
        })),
      },
    ],
  } as unknown as ChatSession;
}

describe('wantsWrapUp', () => {
  it('wraps up completed work the owner launched from a chat', () => {
    expect(wantsWrapUp(task(), 'complete')).toBe(true);
  });

  it('stays quiet for cancels, background work and fanout children', () => {
    expect(wantsWrapUp(task(), 'canceled')).toBe(false);
    expect(wantsWrapUp(task({ launchSessionId: undefined }), 'complete')).toBe(false);
    expect(wantsWrapUp(task({ parentTaskRef: 'default/1' }), 'complete')).toBe(false);
    expect(
      wantsWrapUp(
        task({ origin: { kind: 'system-job', jobId: 'night' } } as Partial<Task>),
        'complete',
      ),
    ).toBe(false);
  });
});

describe('collectTaskOutputs', () => {
  it('lists each written file once, newest first, and skips reads and failures', () => {
    const outputs = collectTaskOutputs(
      [
        session([
          { name: 'write_file', path: 'social/drafts/week.md', at: '2026-09-28T10:01:00.000Z' },
          { name: 'read_file', path: 'admin/scope.md', at: '2026-09-28T10:02:00.000Z' },
          {
            name: 'write_artifact',
            path: 'artifacts/tasks/2/quote.md',
            at: '2026-09-28T10:03:00.000Z',
          },
          {
            name: 'write_file',
            path: 'broken.md',
            success: false,
            at: '2026-09-28T10:04:00.000Z',
          },
          {
            name: 'replace_in_file',
            path: 'social/drafts/week.md',
            at: '2026-09-28T10:05:00.000Z',
          },
        ]),
      ],
      { inputsPrefix: 'tasks/2/inputs/' },
    );
    expect(outputs).toEqual([
      { kind: 'workspace', path: 'social/drafts/week.md' },
      { kind: 'artifact', path: 'tasks/2/quote.md' },
    ]);
  });

  it('never lists the task inputs as something it made', () => {
    const outputs = collectTaskOutputs(
      [session([{ name: 'write_artifact', path: 'tasks/2/inputs/brief.md', at: 'x' }])],
      { inputsPrefix: 'tasks/2/inputs/' },
    );
    expect(outputs).toEqual([]);
  });
});

describe('composeTaskWrapUp', () => {
  it('names the task and links what it made', () => {
    const text = composeTaskWrapUp(task(), [
      { kind: 'artifact', path: 'tasks/2/quote.md' },
      { kind: 'workspace', path: 'social/final/week.md' },
    ]);
    expect(text).toContain('**Weekly posts and catering quote** is finished');
    expect(text).toContain('- `tasks/2/quote.md`');
    expect(text).toContain('- `social/final/week.md` (in the project folder)');
    expect(text).not.toMatch(/Active step|terminal step|default\/2\. /);
  });

  it('points at the task page when there are more files than it lists', () => {
    const many = Array.from({ length: WRAP_UP_MAX_FILES + 2 }, (_, i) => ({
      kind: 'artifact' as const,
      path: `tasks/2/file-${i}.md`,
    }));
    expect(composeTaskWrapUp(task(), many)).toContain('…and 2 more on the task page (default/2)');
  });

  it('still closes the loop when the task wrote no files', () => {
    expect(composeTaskWrapUp(task(), [])).toContain('The task page (default/2) has every step');
  });
});

describe('the deliverable', () => {
  const deck = { kind: 'workspace' as const, path: 'powerpoint/task-2/deck.pptx' };
  const made = [
    { kind: 'artifact' as const, path: 'tasks/2/review.md' },
    deck,
    { kind: 'artifact' as const, path: 'tasks/2/outline.md' },
  ];

  it('counts a copy into the workspace as something the task made', () => {
    const outputs = collectTaskOutputs([
      session([
        {
          name: 'copy_artifact_to_workspace',
          path: 'powerpoint/task-2/deck.pptx',
          at: '2026-09-28T10:01:00.000Z',
        },
      ]),
    ]);
    expect(outputs).toEqual([deck]);
  });

  it('leads the wrap-up with the deliverable and lists the rest as working files', () => {
    const text = composeTaskWrapUp(task(), made, null, deck);
    const lines = text.split('\n');
    expect(lines[2]).toBe(
      "Here's your PowerPoint deck: `powerpoint/task-2/deck.pptx` (in the project folder)",
    );
    expect(text).toContain('Along the way it also made:');
    expect(text.match(/deck\.pptx/g)).toHaveLength(1);
    expect(text).toContain('Open it to review');
  });

  it('puts the deliverable first on the Updates card and never previews a working paper', () => {
    const question = taskFinishedQuestion({
      task: task(),
      thread: { id: 't', gezelId: 'kylian', projectId: 'default' },
      outputs: made,
      at: '2026-09-28T10:00:00.000Z',
      deliverable: deck,
    });
    expect(question.prompt.split('\n')[2]).toBe('- **`powerpoint/task-2/deck.pptx`**');
    expect(question.documentPath).toBeUndefined();
  });

  it('resolves the deck the book published, skipping promised files that never landed', async () => {
    const existing = new Set(['workspace:powerpoint/task-2/deck.pptx']);
    const statFor = (kind: 'artifact' | 'workspace') => async (_id: string, path: string) =>
      existing.has(`${kind}:${path}`)
        ? { kind: 'file' as const, size: 48_000, mtime: '2026-09-28T10:05:00.000Z' }
        : { kind: 'missing' as const };
    const store = {
      statProjectWorkspacePath: statFor('workspace'),
      statProjectArtifactPath: statFor('artifact'),
    } as unknown as TaskOutputStore;
    const withSteps = task({
      artifactDir: 'tasks/2',
      craftbook: {
        steps: [
          { id: 'write', name: 'write', advanceWhen: { file: 'powerpoint/task-2/deck.md' } },
          { id: 'publish', name: 'publish', advanceWhen: { file: 'powerpoint/task-2/deck.pptx' } },
          { id: 'extra', name: 'extra', advanceWhen: { file: 'powerpoint/task-2/final.pdf' } },
        ],
      },
    } as unknown as Partial<Task>);
    await expect(resolveTaskDeliverable(store, withSteps, [])).resolves.toEqual({
      ...deck,
      bytes: 48_000,
      modifiedAt: '2026-09-28T10:05:00.000Z',
    });
  });
});
