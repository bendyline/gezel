import type { RecentTab } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { toRecentTab } from '../recent-tabs.js';
import { entryDetail, entryLabel, entryTitle, fallbackTitle } from './history-titles.js';
import {
  VIEW_HISTORY_LIMIT,
  canGoBack,
  canGoForward,
  createHistory,
  currentEntry,
  parseHistory,
  purge,
  pushSelection,
  replaceSelection,
  rewrite,
  selectionKey,
  serializeHistory,
  setPart,
  setTitle,
  traverse,
} from './view-history.js';

const project = (id: string) => toRecentTab({ kind: 'project', id });
const task = (ref: string) => toRecentTab({ kind: 'task', ref });
const doc = (path: string) => toRecentTab({ kind: 'document', path });

function keys(history: ReturnType<typeof createHistory>): string[] {
  return history.entries.map((entry) => selectionKey(entry.selection));
}

describe('view history', () => {
  it('pushes new places and ignores re-selecting the current one', () => {
    let h = createHistory(null);
    h = pushSelection(h, project('p1'));
    h = pushSelection(h, project('p1'));
    h = pushSelection(h, task('p1/3'));
    expect(keys(h)).toEqual(['home', 'project:p1', 'task:p1/3']);
    expect(h.index).toBe(2);
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(false);
  });

  it('drops the forward entries when a new place follows going back', () => {
    let h = createHistory(null);
    h = pushSelection(h, project('p1'));
    h = pushSelection(h, task('p1/3'));
    h = traverse(h, 0);
    expect(canGoForward(h)).toBe(true);
    h = pushSelection(h, project('p2'));
    expect(keys(h)).toEqual(['home', 'project:p2']);
    expect(canGoForward(h)).toBe(false);
  });

  it('caps the trail, dropping the oldest', () => {
    let h = createHistory(null);
    for (let i = 0; i < VIEW_HISTORY_LIMIT + 10; i++) h = pushSelection(h, project(`p${i}`));
    expect(h.entries).toHaveLength(VIEW_HISTORY_LIMIT);
    expect(h.index).toBe(VIEW_HISTORY_LIMIT - 1);
    expect(selectionKey(currentEntry(h).selection)).toBe(`project:p${VIEW_HISTORY_LIMIT + 9}`);
  });

  it('replaces the current place without adding a step', () => {
    let h = pushSelection(createHistory(null), project('p1'));
    h = replaceSelection(h, null);
    expect(keys(h)).toEqual(['home', 'home']);
    expect(h.index).toBe(1);
  });

  it('clamps traversal to the trail', () => {
    const h = pushSelection(createHistory(null), project('p1'));
    expect(traverse(h, -5).index).toBe(0);
    expect(traverse(h, 99).index).toBe(1);
    expect(traverse(h, 1)).toBe(h);
  });

  describe('parts', () => {
    const at = { selectionKey: 'project:p1' };

    it('annotates the first report and pushes a different one', () => {
      let h = pushSelection(createHistory(null), project('p1'));
      h = setPart(h, 'project', { key: 'chat', value: 'chat', label: 'Chat' }, at);
      expect(h.entries).toHaveLength(2);
      expect(currentEntry(h).parts.project?.key).toBe('chat');
      h = setPart(h, 'project', { key: 'chat', value: 'chat', label: 'Chat' }, at);
      expect(h.entries).toHaveLength(2);
      h = setPart(h, 'project', { key: 'tasks', value: 'tasks', label: 'Tasks' }, at);
      expect(h.entries).toHaveLength(3);
      expect(h.entries[1]?.parts.project?.key).toBe('chat');
      expect(currentEntry(h).parts.project?.key).toBe('tasks');
    });

    it('annotates a redirect instead of adding a step', () => {
      let h = pushSelection(createHistory(null), project('p1'));
      h = setPart(h, 'project', { key: 'chat', value: 'chat' }, at);
      h = setPart(h, 'project', { key: 'overview', value: 'overview' }, { ...at, annotate: true });
      expect(h.entries).toHaveLength(2);
      expect(currentEntry(h).parts.project?.key).toBe('overview');
    });

    it('drops the parts nested under a scope that moved', () => {
      let h = pushSelection(createHistory(null), project('p1'));
      h = setPart(h, 'project/tasks', { key: 'p1/3', value: 'p1/3' }, at);
      h = setPart(h, 'project', { key: 'tasks', value: 'tasks' }, at);
      expect(Object.keys(currentEntry(h).parts).sort()).toEqual(['project', 'project/tasks']);
      h = setPart(h, 'project', { key: 'chat', value: 'chat' }, at);
      expect(Object.keys(currentEntry(h).parts)).toEqual(['project']);
      expect(Object.keys(h.entries[1]?.parts ?? {}).sort()).toEqual(['project', 'project/tasks']);
    });

    it('drops a report from a view that is no longer current', () => {
      let h = pushSelection(createHistory(null), project('p1'));
      h = pushSelection(h, project('p2'));
      const before = h;
      h = setPart(h, 'project', { key: 'tasks', value: 'tasks' }, at);
      expect(h).toBe(before);
    });

    it('updates a label in place', () => {
      let h = pushSelection(createHistory(null), project('p1'));
      h = setPart(h, 'project/tasks', { key: 'p1/3', value: 'p1/3', label: 'Task 3' }, at);
      h = setPart(h, 'project/tasks', { key: 'p1/3', value: 'p1/3', label: 'Draft' }, at);
      expect(h.entries).toHaveLength(2);
      expect(currentEntry(h).parts['project/tasks']?.label).toBe('Draft');
    });
  });

  it('titles every entry for a selection', () => {
    let h = pushSelection(createHistory(null), project('p1'));
    h = setPart(h, 'project', { key: 'chat', value: 'chat' }, { selectionKey: 'project:p1' });
    h = setPart(h, 'project', { key: 'tasks', value: 'tasks' }, { selectionKey: 'project:p1' });
    h = setTitle(h, 'project:p1', 'Invoices');
    expect(h.entries.map((entry) => entry.title)).toEqual([undefined, 'Invoices', 'Invoices']);
    expect(setTitle(h, 'project:p1', 'Invoices')).toBe(h);
  });

  it('purges a deleted thing and collapses the repeat it leaves', () => {
    let h = createHistory(null);
    h = pushSelection(h, project('p1'));
    h = pushSelection(h, project('p2'));
    h = pushSelection(h, project('p1'));
    h = pushSelection(h, project('p2'));
    h = purge(h, (selection) => selection?.kind === 'project' && selection.id === 'p2');
    expect(keys(h)).toEqual(['home', 'project:p1']);
    expect(h.index).toBe(1);
  });

  it('purges down to Home when nothing is left', () => {
    let h = createHistory(project('p1'));
    h = purge(h, () => true);
    expect(keys(h)).toEqual(['home']);
  });

  it('rewrites renamed documents in every entry', () => {
    let h = pushSelection(createHistory(null), doc('notes/a.md'));
    h = pushSelection(h, project('p1'));
    h = rewrite(h, (selection) =>
      selection?.kind === 'document' && selection.path.startsWith('notes/')
        ? { ...selection, path: `archive/${selection.path.slice('notes/'.length)}` }
        : selection,
    );
    expect(keys(h)).toEqual(['home', 'document:archive/a.md', 'project:p1']);
  });

  describe('storage', () => {
    it('round-trips a trail', () => {
      let h = pushSelection(createHistory(null), project('p1'));
      h = setPart(
        h,
        'project',
        { key: 'chat', value: 'chat', label: 'Chat' },
        { selectionKey: 'project:p1' },
      );
      h = setTitle(h, 'project:p1', 'Invoices');
      expect(parseHistory(serializeHistory(h))).toEqual(h);
    });

    it('refuses anything this build did not write', () => {
      expect(parseHistory(null)).toBeNull();
      expect(parseHistory('not json')).toBeNull();
      expect(parseHistory('{"entries":[],"index":0,"nextId":1}')).toBeNull();
      const h = pushSelection(createHistory(null), project('p1'));
      const broken = JSON.parse(serializeHistory(h)) as { entries: { selection: unknown }[] };
      broken.entries[1]!.selection = { kind: 'nonsense' };
      expect(parseHistory(JSON.stringify(broken))).toBeNull();
      expect(parseHistory(JSON.stringify({ ...h, index: 7 }))).toBeNull();
    });
  });
});

describe('history titles', () => {
  it('names places a view has not named', () => {
    expect(fallbackTitle(null)).toBe('Home');
    expect(fallbackTitle(toRecentTab({ kind: 'area', area: 'gezels' }))).toBe('Crew');
    expect(fallbackTitle(task('p1/12'))).toBe('Task 12');
    expect(fallbackTitle(doc('notes/plan.md'))).toBe('plan.md');
  });

  it('names an entry with its view title and the places inside it', () => {
    const entry = {
      id: 1,
      selection: project('p1') as RecentTab,
      parts: {
        'project/tasks': { key: 'p1/3', value: 'p1/3', label: 'Draft the invoices' },
        project: { key: 'tasks', value: 'tasks', label: 'Tasks' },
      },
      title: 'Invoices',
      at: 0,
    };
    expect(entryTitle(entry)).toBe('Invoices');
    expect(entryDetail(entry)).toBe('Tasks · Draft the invoices');
    expect(entryLabel(entry)).toBe('Invoices · Tasks · Draft the invoices');
  });
});
