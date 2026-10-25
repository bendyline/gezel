import type { ChatSession, Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type TaskOutputStore,
  WRAP_UP_MAX_FILES,
  closingQuestion,
  collectTaskOutputs,
  composeTaskWrapUp,
  resolveTaskDeliverable,
  taskFinishedQuestion,
  wantsWrapUp,
  withWrapUpNote,
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
    const text = composeTaskWrapUp(task(), many);
    expect(text).toContain('…and 2 more on the task page.');
    expect(text).not.toContain('default/2');
  });

  it('still closes the loop when the task wrote no files', () => {
    expect(composeTaskWrapUp(task(), [])).toContain('The task page has every step');
  });
});

describe("a board and the maker's question", () => {
  const board = { kind: 'workspace' as const, path: 'trip.json', view: 'output-page' as const };
  const question =
    'Since we have a week to plan, would you like me to continue drafting the rest of the days?';

  it('reads the question the maker ended on, and nothing when they asked none', () => {
    expect(closingQuestion(`I've drafted the first day of your **Lisbon** trip. ${question}`)).toBe(
      question,
    );
    expect(closingQuestion('Day two is on the board. Enjoy Lisbon!')).toBeUndefined();
    // A rhetorical question early on is not the one to pass on.
    expect(
      closingQuestion('Why Sintra? It has palaces. Day three goes there. The rest is planned.'),
    ).toBeUndefined();
  });

  // Day one of a seven-day trip was announced "All done … finished", and the
  // Reisleider's "shall I go on?" never reached the person (2026-10-12).
  it('calls a board ready to look at and passes the question on', () => {
    const text = composeTaskWrapUp(task({ title: 'Lisbon Trip Planning' }), [board], null, board, {
      name: 'Camila',
      question,
    });
    expect(text).toContain(
      "**Lisbon Trip Planning** is ready to look at on the project's Output page.",
    );
    expect(text).not.toMatch(/All done|is finished/);
    expect(text).toContain(`Camila asks: “${question}”`);
    expect(text).toContain('Answer Camila with **Make changes**');
  });

  it('keeps the data file out of the Updates card for a board', () => {
    const card = taskFinishedQuestion({
      task: task({ title: 'Lisbon Trip Planning' }),
      thread: { id: 't', gezelId: 'meester', projectId: 'default' },
      outputs: [board],
      at: '2026-10-12T10:00:00.000Z',
      deliverable: board,
    });
    expect(card.prompt).toBe(
      "**Lisbon Trip Planning** is ready to look at on the project's Output page.",
    );
    expect(card.prompt).not.toContain('trip.json');
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

  // The bakery's wrap-up read "All done — **Formatted Report** is finished.
  // Here's your PDF: `tasks/2/report.pdf`. Along the way it also made: …"
  // (2026-10-23): the book's name, three paths and a list of working papers.
  it('names the deliverable by what it is and leaves its path to the card', () => {
    const text = composeTaskWrapUp(task(), made, null, deck);
    expect(text.split('\n')[0]).toBe(
      'Your PowerPoint deck for **Weekly posts and catering quote** is ready.',
    );
    expect(text).not.toMatch(/deck\.pptx|outline\.md|Along the way|default\/2/);
    expect(text).toContain('Open it to review');
  });

  it("never names the task by the craftbook's own name", () => {
    const pdf = { kind: 'artifact' as const, path: 'tasks/2/report.pdf' };
    const named = task({
      title: 'Formatted Report',
      craftbook: { id: 'report-pdf', name: 'Formatted Report', steps: [] },
    } as unknown as Partial<Task>);
    expect(composeTaskWrapUp(named, [pdf], null, pdf).split('\n')[0]).toBe('Your PDF is ready.');
    expect(composeTaskWrapUp(named, []).split('\n')[0]).toBe('All done — the work is finished.');
  });

  it('gives the model reading the thread back the ref and the paths', () => {
    const message = {
      synthetic: 'task-wrapup' as const,
      referencedTasks: ['default/2'],
      referencedFiles: made,
      deliverable: deck,
    };
    expect(withWrapUpNote(message, 'Your deck is ready.')).toBe(
      'Your deck is ready.\n\n[Task default/2; deliverable `powerpoint/task-2/deck.pptx` (in the project folder); other files: `tasks/2/review.md`, `tasks/2/outline.md`]',
    );
    expect(withWrapUpNote({ ...message, synthetic: undefined }, 'Hello.')).toBe('Hello.');
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
    } as Partial<Task>);
    await expect(resolveTaskDeliverable(store, withSteps, [])).resolves.toEqual({
      ...deck,
      bytes: 48_000,
      modifiedAt: '2026-09-28T10:05:00.000Z',
    });
  });
});
