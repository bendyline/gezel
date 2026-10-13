import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Question } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { withQuestionFileReferences } from './question-files.js';

function question(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    projectId: 'default',
    gezelId: 'vanya',
    sessionId: 'sess-1',
    prompt: 'Which approach?',
    createdAt: '2026-10-13T00:00:00.000Z',
    ...over,
  };
}

describe('withQuestionFileReferences', () => {
  let tmp: string;
  let store: Store;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gezel-question-files-'));
    store = new Store({ home: tmp });
    await store.ensureLayout();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const writeWorkspaceFile = async (projectId: string, path: string, content: string) => {
    const full = join(await store.projectWorkspaceDir(projectId), path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };

  it("links a finished card's outputs, artifacts and project folder alike", async () => {
    await store.writeProjectArtifact('default', 'tasks/12/report.pdf', '%PDF');
    await store.writeProjectArtifact('default', 'tasks/12/outline.md', '# Outline');
    await writeWorkspaceFile('default', 'pdf/task-12/report.md', '# Report');
    const [card] = await withQuestionFileReferences(store, [
      question({
        prompt:
          '**Formatted Report** is finished.\n\n- **`tasks/12/report.pdf`**\n- `pdf/task-12/report.md`\n- `tasks/12/outline.md`',
        taskRef: 'default/12',
      }),
    ]);
    expect(card!.referencedFiles).toEqual([
      { kind: 'artifact', path: 'tasks/12/report.pdf' },
      { kind: 'workspace', path: 'pdf/task-12/report.md' },
      { kind: 'artifact', path: 'tasks/12/outline.md' },
    ]);
  });

  // A kickoff from the Default thread builds in a project of its own, and its
  // finished card is filed in Default, which can hold its own task 2.
  it("opens a task's files in the task's project, not the thread's", async () => {
    const trip = await store.createProject({ name: 'Trip' });
    await store.writeProjectArtifact(trip.id, 'tasks/2/plan.md', '# Trip plan');
    await store.writeProjectArtifact('default', 'tasks/2/plan.md', '# Something else');
    const [card] = await withQuestionFileReferences(store, [
      question({ prompt: '- `tasks/2/plan.md`', taskRef: `${trip.id}/2` }),
    ]);
    expect(card!.referencedFiles).toEqual([
      { kind: 'artifact', path: 'tasks/2/plan.md', projectId: trip.id },
    ]);
  });

  it('leaves answered cards and prompts naming no real file untouched', async () => {
    await store.writeProjectArtifact('default', 'notes.md', '# Notes');
    const answered = question({
      prompt: 'Read `notes.md`?',
      answer: { selectedChoices: [0], at: '2026-10-13T00:01:00.000Z' },
    });
    const plain = question({ id: 'q2', prompt: 'Should I add `imaginary.md` later?' });
    const out = await withQuestionFileReferences(store, [answered, plain]);
    expect(out).toEqual([answered, plain]);
  });
});
