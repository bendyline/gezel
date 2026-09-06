import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { craftbookIdFromScenarioId, summarizeCraftbookDrove } from './craftbook-drove.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-craftbook-drove-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeState(tasks: unknown[]): Promise<void> {
  await writeFile(join(dir, 'state.json'), JSON.stringify({ tasks: { tasks, waiting: [] } }));
}

async function writeHistoryTask(name: string, task: unknown): Promise<void> {
  const historyDir = join(dir, 'recording', 'task-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, name), JSON.stringify(task));
}

describe('craftbookIdFromScenarioId', () => {
  it('peels the scenario prefix', () => {
    expect(craftbookIdFromScenarioId('craftbook-a11y-audit')).toBe('a11y-audit');
  });

  it('returns null for a non-craftbook scenario', () => {
    expect(craftbookIdFromScenarioId('tictactoe')).toBeNull();
  });

  it('returns null for an authoring scenario, which grades a book the model wrote', () => {
    expect(craftbookIdFromScenarioId('craftbook-author-linear')).toBeNull();
    expect(craftbookIdFromScenarioId('craftbook-find-vs-create')).toBeNull();
  });
});

describe('summarizeCraftbookDrove', () => {
  it('is null for a scenario that is not a craftbook trial', async () => {
    await writeState([]);
    expect(summarizeCraftbookDrove(dir, 'tictactoe')).toBeNull();
  });

  it('is null for an authoring scenario, so it is never reported as artifact-only', async () => {
    await writeState([{ ref: 'p/1', craftbook: { id: 'whatever' }, status: 'active' }]);
    expect(summarizeCraftbookDrove(dir, 'craftbook-author-linear')).toBeNull();
  });

  it('reports artifact-only when no task was sourced from the book', async () => {
    // The observed shape of a passing artifact-task trial: the only tasks in
    // the home are the daemon's own system jobs.
    await writeState([
      { ref: 'shared/1', craftbook: { id: 'task-aac3aab8' }, status: 'active' },
      { ref: 'default/1', craftbook: { id: 'task-7a998131' }, status: 'active' },
    ]);
    expect(summarizeCraftbookDrove(dir, 'craftbook-a11y-audit')).toEqual({
      craftbookId: 'a11y-audit',
      tasksObserved: 2,
      craftbookTasks: 0,
      reachedTerminal: false,
      verdict: 'artifact-only',
    });
  });

  it('matches an embedded craftbook by id', async () => {
    await writeState([
      {
        ref: 'p/1',
        craftbook: {
          id: 'a11y-audit',
          steps: [{ id: 'report' }, { id: 'finish', terminal: true }],
        },
        activeStepId: 'report',
        status: 'active',
      },
    ]);
    const summary = summarizeCraftbookDrove(dir, 'craftbook-a11y-audit');
    expect(summary?.verdict).toBe('drove');
    expect(summary?.craftbookTasks).toBe(1);
    expect(summary?.reachedTerminal).toBe(false);
  });

  it('matches through sourceCraftbookIds when the embedded copy was renamed', async () => {
    await writeState([
      {
        ref: 'p/1',
        craftbook: { id: 'task-91ab' },
        sourceCraftbookIds: [{ catalogId: 'a11y-audit' }],
        status: 'active',
        activeStepId: 'scope',
      },
    ]);
    expect(summarizeCraftbookDrove(dir, 'craftbook-a11y-audit')?.verdict).toBe('drove');
  });

  it('counts a task sitting on a terminal step as reaching terminal', async () => {
    await writeState([
      {
        ref: 'p/1',
        craftbook: { id: 'a11y-audit', steps: [{ id: 'finish', terminal: true }] },
        activeStepId: 'finish',
        status: 'active',
      },
    ]);
    expect(summarizeCraftbookDrove(dir, 'craftbook-a11y-audit')?.reachedTerminal).toBe(true);
  });

  it('reads completed tasks out of the recording capture, not just live state', async () => {
    // The best outcome — the book ran to completion — is exactly the case
    // that leaves state.json, so state alone would report it as "never ran".
    await writeState([{ ref: 'shared/1', craftbook: { id: 'task-sys' }, status: 'active' }]);
    await writeHistoryTask('p-1.json', {
      ref: 'p/1',
      craftbook: { id: 'a11y-audit' },
      status: 'complete',
    });
    const summary = summarizeCraftbookDrove(dir, 'craftbook-a11y-audit');
    expect(summary?.verdict).toBe('drove');
    expect(summary?.reachedTerminal).toBe(true);
    expect(summary?.tasksObserved).toBe(2);
  });

  it('reports unknown rather than artifact-only when no task state was captured', async () => {
    expect(summarizeCraftbookDrove(dir, 'craftbook-a11y-audit')?.verdict).toBe('unknown');
  });
});
