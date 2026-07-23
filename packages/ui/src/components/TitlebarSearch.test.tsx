import type { UnifiedSearchResult } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

import { api } from '../api.js';
import { TitlebarSearch } from './TitlebarSearch.js';

const RESULTS: UnifiedSearchResult[] = [
  { kind: 'project', id: 'project:p1', title: 'Space Shooter', projectId: 'p1', score: 900 },
  {
    kind: 'file',
    id: 'file:p1:src/index.html',
    title: 'index.html',
    subtitle: 'Space Shooter · src/index.html',
    projectId: 'p1',
    path: 'src/index.html',
    source: 'workspace',
    score: 600,
  },
];

beforeEach(() => {
  vi.mocked(api.search).mockResolvedValue({ results: RESULTS, truncated: false });
  vi.mocked(api.quickOpen).mockResolvedValue({ results: RESULTS, truncated: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function typeQuery(value: string) {
  const input = screen.getByTestId('titlebar-search-input');
  fireEvent.change(input, { target: { value } });
  // Flush the 150ms debounce + the resolved fetch.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  return input;
}

describe('TitlebarSearch', () => {
  it('renders grouped results after typing', async () => {
    render(<TitlebarSearch />);
    await typeQuery('space');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('Files')).toBeTruthy();
    expect(screen.getByText('Space Shooter')).toBeTruthy();
    expect(screen.getByText('index.html')).toBeTruthy();
  });

  it('navigates with arrow keys and dispatches events on Enter', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(<TitlebarSearch />);
    const input = await typeQuery('space');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());

    // Move to the second option (the file) and select it.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    const types = dispatch.mock.calls
      .map((c) => c[0])
      .filter((e): e is CustomEvent => e instanceof CustomEvent)
      .map((e) => e.type);
    expect(types).toContain('gezel:open-tab');
    expect(types).toContain('gezel:open-file');
  });

  it('selecting the first (project) result opens that project', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(<TitlebarSearch />);
    const input = await typeQuery('space');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());

    fireEvent.keyDown(input, { key: 'Enter' }); // activeIndex 0 = project

    const openTab = dispatch.mock.calls
      .map((c) => c[0])
      .find((e): e is CustomEvent => e instanceof CustomEvent && e.type === 'gezel:open-tab');
    expect(openTab?.detail).toEqual({ kind: 'project', id: 'p1' });
  });

  it('focuses the input on gezel:focus-search', () => {
    render(<TitlebarSearch />);
    act(() => {
      window.dispatchEvent(new CustomEvent('gezel:focus-search', { detail: { mode: 'search' } }));
    });
    expect(document.activeElement).toBe(screen.getByTestId('titlebar-search-input'));
  });

  it('Escape closes the palette', async () => {
    render(<TitlebarSearch />);
    const input = await typeQuery('space');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });
});
