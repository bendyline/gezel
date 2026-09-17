import { describe, expect, it } from 'vitest';
import {
  type TaskPathSource,
  deniedTaskScopedWrite,
  isInsideFolder,
  normalizeFolder,
  taskOwnedPrefixes,
  taskScopedWriteDeniedMessage,
} from './task-owned-paths.js';

const task = (over: Partial<TaskPathSource> = {}): TaskPathSource => ({
  ref: 'default/2',
  num: 2,
  status: 'active',
  craftbookParams: { workPath: 'tasks/2', outputDir: 'powerpoint/task-2' },
  ...over,
});

describe('taskOwnedPrefixes', () => {
  it('claims the declared artifact and workspace folders of a live task', () => {
    expect(taskOwnedPrefixes([task()])).toEqual([
      { taskRef: 'default/2', surface: 'artifacts', prefix: 'tasks/2' },
      { taskRef: 'default/2', surface: 'workspace', prefix: 'powerpoint/task-2' },
    ]);
  });

  it('falls back to the per-task artifact folder when the book named none', () => {
    const owned = taskOwnedPrefixes([task({ craftbookParams: {} })]);
    expect(owned).toEqual([{ taskRef: 'default/2', surface: 'artifacts', prefix: 'tasks/2' }]);
  });

  it('claims no workspace folder when the book declared no outputDir', () => {
    // Inferring one from a deliverable's parent would let a book writing
    // README.md at the root claim the entire workspace.
    const owned = taskOwnedPrefixes([task({ craftbookParams: { workPath: 'tasks/2' } })]);
    expect(owned.some((o) => o.surface === 'workspace')).toBe(false);
  });

  it('releases folders once the task is finished', () => {
    for (const status of ['complete', 'canceled', 'draft']) {
      expect(taskOwnedPrefixes([task({ status })])).toEqual([]);
    }
    // A paused task still owns its work — that is exactly when a stray writer
    // is most likely to wander in.
    expect(taskOwnedPrefixes([task({ status: 'paused' })]).length).toBe(2);
  });
});

describe('deniedTaskScopedWrite', () => {
  const owned = taskOwnedPrefixes([task()]);

  // The incident: a recovery nudge landed in an unbound chat session, which
  // then wrote powerpoint/task-2/deck.md and destroyed an 11-slide deck.
  it('refuses an unbound session writing into a live task folder', () => {
    const denial = deniedTaskScopedWrite({
      path: 'powerpoint/task-2/deck.md',
      surface: 'workspace',
      owned,
    });
    expect(denial).toMatchObject({ taskRef: 'default/2', surface: 'workspace' });
  });

  it('refuses an unbound session writing into the artifact folder', () => {
    expect(
      deniedTaskScopedWrite({ path: 'tasks/2/outline.md', surface: 'artifacts', owned }),
    ).toMatchObject({ taskRef: 'default/2' });
  });

  it('allows the task’s own step session', () => {
    expect(
      deniedTaskScopedWrite({
        path: 'powerpoint/task-2/deck.md',
        surface: 'workspace',
        writerTaskRef: 'default/2',
        owned,
      }),
    ).toBeNull();
  });

  it('leaves cross-task writes alone — a narrower policy question', () => {
    expect(
      deniedTaskScopedWrite({
        path: 'powerpoint/task-2/deck.md',
        surface: 'workspace',
        writerTaskRef: 'default/7',
        owned,
      }),
    ).toBeNull();
  });

  it('does not confuse a sibling folder with a prefix match', () => {
    // `powerpoint/task-20` must not read as inside `powerpoint/task-2`.
    expect(
      deniedTaskScopedWrite({ path: 'powerpoint/task-20/deck.md', surface: 'workspace', owned }),
    ).toBeNull();
  });

  it('does not police the surface the task did not claim', () => {
    expect(
      deniedTaskScopedWrite({ path: 'tasks/2/outline.md', surface: 'workspace', owned }),
    ).toBeNull();
  });

  it('leaves ordinary paths writable', () => {
    for (const path of ['README.md', 'src/cart.js', 'notes/scratch.md']) {
      expect(deniedTaskScopedWrite({ path, surface: 'workspace', owned })).toBeNull();
    }
  });
});

describe('normalizeFolder / isInsideFolder', () => {
  it('normalizes the shapes different callers report', () => {
    for (const v of ['tasks/2', './tasks/2', '/tasks/2/', 'tasks\\2']) {
      expect(normalizeFolder(v)).toBe('tasks/2');
    }
    expect(normalizeFolder(undefined)).toBe('');
  });

  it('matches on folder boundaries only', () => {
    expect(isInsideFolder('a/b/c.md', 'a/b')).toBe(true);
    expect(isInsideFolder('a/b', 'a/b')).toBe(true);
    expect(isInsideFolder('a/bb/c.md', 'a/b')).toBe(false);
    expect(isInsideFolder('a/b/c.md', '')).toBe(false);
  });
});

describe('taskScopedWriteDeniedMessage', () => {
  it('names the owner, the folder, and the one legitimate route', () => {
    const msg = taskScopedWriteDeniedMessage(
      { taskRef: 'default/2', prefix: 'powerpoint/task-2', surface: 'workspace' },
      'powerpoint/task-2/deck.md',
    );
    expect(msg).toContain('default/2');
    expect(msg).toContain('powerpoint/task-2/');
    expect(msg).toContain("task's step session");
  });
});
