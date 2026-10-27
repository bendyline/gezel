import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Question, answeredQuestion, newQuestion } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { portableStoreOverHome } from '../test-support/portable-node-files.js';
import { Store } from './store.js';

/** Both hosts read and write `projects/<id>/questions.json`; they must agree. */
const at = (n: number) => `2026-09-22T10:0${n}:00.000Z`;
const ask = (id: string, n: number, extra: Partial<Question> = {}): Question => ({
  ...newQuestion(
    {
      projectId: 'default',
      gezelId: 'maya',
      sessionId: `s-${id}`,
      prompt: `Q ${id}`,
      choices: ['a', 'b'],
    },
    { id, at: at(n) },
  ),
  ...extra,
});

let homes: string[] = [];
async function desktopHome(): Promise<{ home: string; store: Store }> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-questions-contract-'));
  homes.push(home);
  const store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
  for (const q of [
    ask('q1', 1),
    answeredQuestion(ask('q2', 2), { selectedChoices: [0] }, at(3)),
    ask('q3', 4),
  ])
    await store.writeQuestion(q);
  return { home, store };
}
beforeEach(() => {
  homes = [];
});
afterEach(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

describe('question records agree across hosts', () => {
  it('lists the same pending questions in the same order', async () => {
    const { home, store } = await desktopHome();
    const desktop = await store.listAllPendingQuestions();
    const portable = await portableStoreOverHome(home).listQuestions({ pending: true });
    expect(desktop.map((q) => q.id)).toEqual(['q3', 'q1']);
    expect(portable).toEqual(desktop);
  });

  it('writes the same answered record through either host', async () => {
    const a = await desktopHome();
    const b = await desktopHome();
    const pending = (await a.store.listAllPendingQuestions()).find((q) => q.id === 'q1')!;
    await a.store.writeQuestion(
      answeredQuestion(pending, { silentSkip: true }, at(5), { validate: true }),
    );
    await portableStoreOverHome(b.home, { now: () => at(5) }).answerQuestion('q1', {
      silentSkip: true,
    });
    // The file's array order is not a contract (readers sort); the records are.
    const read = async (home: string) =>
      (
        JSON.parse(
          await readFile(join(home, 'projects', 'default', 'questions.json'), 'utf8'),
        ) as Question[]
      )
        .slice()
        .sort((x, y) => x.id.localeCompare(y.id));
    expect(await read(b.home)).toEqual(await read(a.home));
  });
});

describe('desktop question writes', () => {
  it('keeps every card when several are filed at once', async () => {
    const { store } = await desktopHome();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.writeQuestion(ask(`burst-${i}`, i % 10))),
    );
    const ids = (await store.listProjectQuestions('default')).map((q) => q.id);
    for (let i = 0; i < 12; i++) expect(ids).toContain(`burst-${i}`);
  });

  it('applies a batch of edits in one rewrite, and none when nothing changed', async () => {
    const { home, store } = await desktopHome();
    const file = join(home, 'projects', 'default', 'questions.json');
    const before = await readFile(file, 'utf8');
    await store.updateProjectQuestions('default', () => false);
    expect(await readFile(file, 'utf8')).toBe(before);
    await store.updateProjectQuestions('default', (questions) => {
      for (const [index, question] of questions.entries()) {
        if (!question.answer)
          questions[index] = answeredQuestion(question, { silentSkip: true }, at(9));
      }
      return true;
    });
    expect(await store.listAllPendingQuestions()).toEqual([]);
  });

  it('reuses the parsed list until the file changes, and an abandoned edit leaks nothing', async () => {
    const { home, store } = await desktopHome();
    const first = await store.listProjectQuestions('default');
    const again = await store.listProjectQuestions('default');
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
    await store.updateProjectQuestions('default', (questions) => {
      for (const question of questions) question.prompt = 'edited, then abandoned';
      return false;
    });
    expect((await store.listProjectQuestions('default')).map((q) => q.prompt)).toEqual([
      'Q q3',
      'Q q2',
      'Q q1',
    ]);
    // A write from this store and one from another process are both seen.
    await store.writeQuestion(ask('q4', 5));
    expect((await store.listProjectQuestions('default')).map((q) => q.id)[0]).toBe('q4');
    const other = new Store({ home });
    await other.writeQuestion(ask('q5', 6));
    expect((await store.listProjectQuestions('default')).map((q) => q.id)[0]).toBe('q5');
  });
});
