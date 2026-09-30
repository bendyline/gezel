import { describe, expect, it } from 'vitest';
import type { Task } from '../schemas/task.js';
import { portableToolResultText } from './portable-tool-results.js';
import { portableFixture } from './test-files.js';

async function fixture() {
  const { store } = portableFixture();
  await store.ensureLayout();
  const gezel = await store.createGezel({ name: 'Wren', role: 'Generalist' });
  const task = await store.createTask('default', {
    title: 'Write the note',
    description: 'Write the handover note for the next volunteer.',
    assignee: { kind: 'gezel', gezelId: gezel.id },
    steps: [
      {
        id: 'write',
        name: 'Write',
        prompt: 'Write `tasks/1/note.md`.',
        advanceWhen: { file: 'tasks/1/note.md', artifact: true },
      },
      { id: 'review', name: 'Review', prompt: 'Check it.' },
    ],
  });
  const session = await store.createSession({
    gezelId: gezel.id,
    providerName: 'llama-cpp',
    taskRef: task.ref,
    stepId: 'write',
  });
  return { store, session, task };
}

describe('portableToolResultText', () => {
  it("reports a gate rejection as the desktop's error", async () => {
    const { store, session, task } = await fixture();
    const rendered = await portableToolResultText(
      store,
      session,
      'advance_task_step',
      { ref: task.ref },
      {
        task,
        completedStepId: 'write',
        gate: {
          decision: 'reject',
          message: 'tasks/1/note.md is missing.',
          attempt: 1,
          maxAttempts: 3,
          paused: false,
        },
      },
    );
    expect(rendered).toEqual({
      isError: true,
      text: `[gate_rejected] Step "write" on ${task.ref} was NOT completed — its gate rejected the work (attempt 1/3):\n\ntasks/1/note.md is missing.\n Address these specifically, then call \`advance_task_step\` again.\nRetryable: true`,
    });
  });

  it('tells a gated step that saving an artifact does not approve it', async () => {
    const { store, session } = await fixture();
    const rendered = await portableToolResultText(
      store,
      session,
      'write_artifact',
      { path: 'tasks/1/note.md' },
      { path: 'tasks/1/note.md', written: true },
    );
    expect(rendered?.text).toMatch(
      /^Wrote tasks\/1\/note\.md\nThis step uses automatic completion checks\./,
    );
  });

  it('reports a line edit with its counts and the region as it now reads', async () => {
    const { store, session } = await fixture();
    const rendered = await portableToolResultText(
      store,
      session,
      'replace_lines',
      { path: 'a.txt', startLine: 2, endLine: 2, content: 'two\nthree' },
      { path: 'a.txt', addedLines: 2, removedLines: 1, content: 'one\ntwo\nthree\nfour\n' },
    );
    expect(rendered?.text).toBe(
      'Edited a.txt (+2 −1).\n\nEvery line after 2 shifted by +1 — line numbers from an earlier read_file are stale past that point.\na.txt now reads:\n1→one\n2→two\n3→three\n4→four',
    );
  });

  it('completes an advance in one plain sentence first', async () => {
    const { store, session, task } = await fixture();
    const advanced = { ...task, activeStepId: 'review' } as Task;
    const rendered = await portableToolResultText(
      store,
      session,
      'advance_task_step',
      { ref: task.ref },
      { task: advanced, completedStepId: 'write' },
    );
    expect(rendered?.isError).toBe(false);
    expect(rendered?.text.split('\n\n')[0]).toBe('Finished "Write". Next: "Review".');
  });
});
