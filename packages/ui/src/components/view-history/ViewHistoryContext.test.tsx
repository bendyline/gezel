import type { RecentTab } from '@bendyline/gezel';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { toRecentTab } from '../recent-tabs.js';
import {
  ViewHistoryProvider,
  ViewLocationRoot,
  ViewLocationScope,
  useRestoredViewPart,
  useViewHistoryApi,
  useViewHistoryState,
  useViewLocation,
} from './ViewHistoryContext.js';
import { entryLabel } from './history-titles.js';
import { VIEW_HISTORY_STORAGE_KEY, currentEntry, selectionKey } from './view-history.js';

const project = (id: string) => toRecentTab({ kind: 'project', id });

/** App's part of the contract, cut down: selection follows a traversal. */
function Harness({ children }: { children?: (selection: RecentTab | null) => React.ReactNode }) {
  const [selection, setSelection] = useState<RecentTab | null>(null);
  const [state, dispatch] = useViewHistoryState(null);
  const api = useViewHistoryApi(state, dispatch);
  const open = (next: RecentTab) => {
    dispatch({ type: 'push', selection: next });
    setSelection(next);
  };
  const applied = useRef(state.revision);
  useEffect(() => {
    if (state.revision === applied.current) return;
    applied.current = state.revision;
    const entry = currentEntry(state.history);
    if (selectionKey(entry.selection) !== selectionKey(selection)) setSelection(entry.selection);
  }, [state, selection]);
  return (
    <ViewHistoryProvider value={api}>
      <button type="button" onClick={() => open(project('p1'))}>
        Open p1
      </button>
      <button type="button" onClick={() => open(project('p2'))}>
        Open p2
      </button>
      <button type="button" onClick={api.back} disabled={!api.canGoBack}>
        Back
      </button>
      <button type="button" onClick={api.forward} disabled={!api.canGoForward}>
        Forward
      </button>
      <output aria-label="Trail">
        {state.history.entries
          .map((entry, i) => `${i === state.history.index ? '*' : ''}${entryLabel(entry)}`)
          .join(' > ')}
      </output>
      <ViewLocationRoot selection={selection}>
        {children
          ? children(selection)
          : selection?.kind === 'project' && <FakeProject key={selection.id} id={selection.id} />}
      </ViewLocationRoot>
    </ViewHistoryProvider>
  );
}

function FakeProject({ id }: { id: string }) {
  const restored = useRestoredViewPart('project');
  const [tab, setTab] = useState(() => (restored?.value as string | undefined) ?? 'chat');
  const location = useViewLocation('project', {
    part: { key: tab, value: tab, label: tab },
    title: `Project ${id}`,
    onRestore: (part) => setTab(part.value as string),
  });
  return (
    <section aria-label={`Project ${id}`}>
      <button type="button" onClick={() => setTab('chat')}>
        Chat tab
      </button>
      <button type="button" onClick={() => setTab('tasks')}>
        Tasks tab
      </button>
      <button
        type="button"
        onClick={() => {
          location.replaceNext('overview');
          setTab('overview');
        }}
      >
        Redirect to overview
      </button>
      <button type="button" onClick={() => location.replaceNext(tab)}>
        Arm a correction that changes nothing
      </button>
      <button type="button" onClick={() => location.replaceNext('overview')}>
        Arm a correction that never happens
      </button>
      <output aria-label="Tab">{tab}</output>
      {tab === 'tasks' && (
        <ViewLocationScope location={location}>
          <FakeTasks />
        </ViewLocationScope>
      )}
    </section>
  );
}

function FakeTasks() {
  const restored = useRestoredViewPart('tasks');
  const [ref, setRef] = useState(() => (restored?.value as string | undefined) ?? 't1');
  useViewLocation('tasks', {
    part: { key: ref, value: ref, label: ref },
    onRestore: (part) => setRef(part.value as string),
  });
  return (
    <div>
      <button type="button" onClick={() => setRef('t2')}>
        Task t2
      </button>
      <output aria-label="Task">{ref}</output>
    </div>
  );
}

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const trail = () => screen.getByRole('status', { name: 'Trail' }).textContent;
const shown = (name: string) => screen.getByRole('status', { name }).textContent;

describe('view locations', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('makes each tab and chosen item a step, and walks them back and forward', () => {
    render(<Harness />);
    click('Open p1');
    click('Tasks tab');
    click('Task t2');
    expect(trail()).toBe(
      'Home > Project p1 · chat > Project p1 · tasks · t1 > *Project p1 · tasks · t2',
    );

    click('Back');
    expect(shown('Task')).toBe('t1');
    click('Back');
    expect(shown('Tab')).toBe('chat');
    expect(screen.queryByRole('status', { name: 'Task' })).toBeNull();
    click('Back');
    expect(screen.queryByRole('region', { name: 'Project p1' })).toBeNull();

    click('Forward');
    click('Forward');
    expect(shown('Tab')).toBe('tasks');
    expect(shown('Task')).toBe('t1');
    click('Forward');
    expect(shown('Task')).toBe('t2');
    // Walking never added a step of its own.
    expect(trail()).toBe(
      'Home > Project p1 · chat > Project p1 · tasks · t1 > *Project p1 · tasks · t2',
    );
  });

  it('reopens a view on the place it was left when Back remounts it', () => {
    render(<Harness />);
    click('Open p1');
    click('Tasks tab');
    click('Task t2');
    click('Open p2');
    click('Back');
    expect(shown('Tab')).toBe('tasks');
    expect(shown('Task')).toBe('t2');
    expect(trail()).toBe(
      'Home > Project p1 · chat > Project p1 · tasks · t1 > *Project p1 · tasks · t2 > Project p2 · chat',
    );
  });

  it('drops the steps ahead when a new move follows going back', () => {
    render(<Harness />);
    click('Open p1');
    click('Tasks tab');
    click('Back');
    click('Open p2');
    expect(trail()).toBe('Home > Project p1 · chat > *Project p2 · chat');
  });

  it('records a correction without adding a step', () => {
    render(<Harness />);
    click('Open p1');
    click('Redirect to overview');
    expect(trail()).toBe('Home > *Project p1 · overview');
  });

  it('never lets an unused correction swallow the next move', () => {
    render(<Harness />);
    click('Open p1');
    click('Arm a correction that changes nothing');
    click('Tasks tab');
    expect(trail()).toBe('Home > Project p1 · chat > *Project p1 · tasks · t1');
    click('Arm a correction that never happens');
    click('Chat tab');
    click('Tasks tab');
    expect(trail()).toBe(
      'Home > Project p1 · chat > Project p1 · tasks · t1 > Project p1 · chat > *Project p1 · tasks · t1',
    );
  });

  it('keeps the trail in sessionStorage for a reload', () => {
    const first = render(<Harness />);
    click('Open p1');
    click('Tasks tab');
    first.unmount();
    const stored = window.sessionStorage.getItem(VIEW_HISTORY_STORAGE_KEY);
    expect(stored).toContain('"id":"p1"');
    // The reload reopens Home, not where the trail ends, so it starts afresh.
    render(<Harness />);
    expect(trail()).toBe('*Home');
  });

  it('works without a provider, as in the embedded chat', () => {
    render(
      <ViewLocationRoot selection={project('p1')}>
        <FakeProject id="p1" />
      </ViewLocationRoot>,
    );
    act(() => click('Tasks tab'));
    expect(shown('Tab')).toBe('tasks');
    expect(shown('Task')).toBe('t1');
  });
});
