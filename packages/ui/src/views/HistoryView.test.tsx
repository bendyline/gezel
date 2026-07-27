import type { GezelSummary, HistoryEntry, Project } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

// Replace the singleton api with a fresh mock so each test starts clean.
// `createMockApi()` returns a Proxy that lazily attaches a vi.fn() the
// first time a method is accessed; `vi.mocked(api.X).mockResolvedValue`
// in each test then customizes responses.
vi.mock('../api.js', () => ({ api: createMockApi() }));

// Stub the Radix Select primitive so filter dropdowns behave as plain
// <select> in tests — we're testing HistoryView, not Radix portals.
vi.mock('../primitives/index.js', () => primitivesMock);

const { HistoryView } = await import('./HistoryView.js');
const { api } = await import('../api.js');

function makeEvent(overrides: Partial<HistoryEntry & { entryType: 'event' }> = {}): HistoryEntry {
  return {
    entryType: 'event',
    id: 'e-1',
    kind: 'gezel.created',
    summary: 'Created gezel Maya',
    at: new Date().toISOString(),
    gezelId: 'gz-maya',
    projectId: 'pj-default',
    ...overrides,
  } as HistoryEntry;
}

function makeSession(
  overrides: Partial<HistoryEntry & { entryType: 'session' }> = {},
): HistoryEntry {
  return {
    entryType: 'session',
    id: 'sess-1',
    title: 'how do I bake bread',
    gezelId: 'gz-maya',
    projectId: 'pj-default',
    messageCount: 5,
    durationMs: 120_000,
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  } as HistoryEntry;
}

const FAKE_GEZELS: GezelSummary[] = [
  { id: 'gz-maya', name: 'Maya', role: 'Researcher' } as GezelSummary,
  { id: 'gz-bob', name: 'Bob' } as GezelSummary,
];

const FAKE_PROJECTS: Project[] = [
  { id: 'pj-default', name: 'default' } as Project,
  { id: 'pj-alpha', name: 'Alpha' } as Project,
];

describe('HistoryView', () => {
  beforeEach(() => {
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: FAKE_GEZELS });
    vi.mocked(api.listProjects).mockResolvedValue({ projects: FAKE_PROJECTS });
    vi.mocked(api.listHistory).mockResolvedValue({ entries: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty-state hint when no entries come back', async () => {
    render(<HistoryView />);
    await waitFor(() => {
      expect(screen.getByText(/No entries yet/i)).toBeInTheDocument();
    });
    expect(api.listHistory).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });

  it('lists event and session entries with their gezel + project chips', async () => {
    vi.mocked(api.listHistory).mockResolvedValue({
      entries: [
        makeEvent({ id: 'e-1', kind: 'gezel.created', summary: 'Created gezel Maya' }),
        makeSession({ id: 'sess-1', title: 'how do I bake bread', messageCount: 5 }),
      ],
    });
    render(<HistoryView />);

    await waitFor(() => {
      // getAllByText: the newest entry auto-selects, so its summary also
      // appears in the detail pane.
      expect(screen.getAllByText(/Created gezel Maya/).length).toBeGreaterThan(0);
    });

    // Event row shows the kind, summary, and chips for project + gezel.
    const kindEls = screen.getAllByText('Gezel created');
    expect(kindEls.some((el) => el.className.includes('history-kind'))).toBe(true);
    expect(screen.getAllByText('Maya').length).toBeGreaterThanOrEqual(1);

    // Session row uses its own renderer with msg count and activity.
    expect(screen.getByText(/how do I bake bread/)).toBeInTheDocument();
    expect(screen.getByText(/5 msgs/)).toBeInTheDocument();
  });

  it('shows the API error when listHistory rejects', async () => {
    vi.mocked(api.listHistory).mockRejectedValue(new Error('boom — 503'));
    render(<HistoryView />);
    await waitFor(() => {
      expect(screen.getByText(/boom — 503/)).toBeInTheDocument();
    });
  });

  it('selecting an entry renders its raw JSON in the detail pane', async () => {
    const evt = makeEvent({ id: 'e-99', summary: 'Renamed Maya to Mai' });
    vi.mocked(api.listHistory).mockResolvedValue({ entries: [evt] });
    render(<HistoryView />);

    const row = await screen.findByRole('button', { name: /Renamed Maya to Mai/ });
    fireEvent.click(row);

    // The detail pane is a <pre> with the JSON-stringified entry.
    const pre = await screen.findByText(
      (content, node) => node?.tagName === 'PRE' && content.includes('Renamed Maya to Mai'),
    );
    expect(pre.textContent).toContain('"id": "e-99"');
  });

  it('typing in the search box and clicking Refresh re-queries with q', async () => {
    render(<HistoryView />);
    await waitFor(() => {
      expect(api.listHistory).toHaveBeenCalled();
    });
    vi.mocked(api.listHistory).mockClear();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Search…'), 'maya');
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      expect(api.listHistory).toHaveBeenCalledWith(expect.objectContaining({ q: 'maya' }));
    });
  });

  it('selecting a kind filter triggers a refetch with that kind', async () => {
    render(<HistoryView />);
    await waitFor(() => {
      expect(api.listHistory).toHaveBeenCalled();
    });
    vi.mocked(api.listHistory).mockClear();

    // Three Select dropdowns exist: project, gezel, kind. The mock
    // primitive renders each as a real <select>; the kind one is the
    // third. Pick by its option text since "All projects" / "All gezels"
    // / "All kinds" are unique to each.
    const kindSelect = screen.getAllByTestId('mock-select').find((el) => {
      return within(el).queryByText(/All kinds/) !== null;
    });
    expect(kindSelect).toBeDefined();

    fireEvent.change(kindSelect as HTMLSelectElement, { target: { value: 'gezel.created' } });

    await waitFor(() => {
      expect(api.listHistory).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'gezel.created' }),
      );
    });
  });

  it('the "session" kind filter is applied client-side, not via the API kind param', async () => {
    vi.mocked(api.listHistory).mockResolvedValue({
      entries: [
        makeEvent({ id: 'e-1', summary: 'event entry' }),
        makeSession({ id: 'sess-1', title: 'session entry' }),
      ],
    });
    render(<HistoryView />);
    await waitFor(() => {
      expect(api.listHistory).toHaveBeenCalled();
    });
    vi.mocked(api.listHistory).mockClear();

    const kindSelect = screen.getAllByTestId('mock-select').find((el) => {
      return within(el).queryByText(/All kinds/) !== null;
    }) as HTMLSelectElement;
    fireEvent.change(kindSelect, { target: { value: 'session' } });

    await waitFor(() => {
      const lastCall = vi.mocked(api.listHistory).mock.calls.at(-1)?.[0] as
        | { kind?: string }
        | undefined;
      expect(lastCall?.kind).toBeUndefined();
    });

    // The event row should disappear, the session row should remain.
    await waitFor(() => {
      expect(screen.queryByText(/event entry/)).not.toBeInTheDocument();
    });
    expect(screen.getAllByText(/session entry/).length).toBeGreaterThan(0);
  });

  it('hides the project filter when a projectId prop is provided (embedded mode)', async () => {
    render(<HistoryView projectId="pj-default" />);

    await waitFor(() => {
      expect(api.listHistory).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'pj-default' }),
      );
    });

    // The remaining Select dropdowns should NOT include "All projects".
    const allSelects = screen.getAllByTestId('mock-select');
    const hasProjectSelect = allSelects.some(
      (el) => within(el).queryByText(/All projects/) !== null,
    );
    expect(hasProjectSelect).toBe(false);
  });
});
