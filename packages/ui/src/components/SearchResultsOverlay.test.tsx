import type { UnifiedSearchResult } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

import { api } from '../api.js';
import { SearchResultsOverlay, openSearchResults } from './SearchResultsOverlay.js';

const RESULTS: UnifiedSearchResult[] = [
  {
    kind: 'project',
    id: 'project:p1',
    title: 'Space Workshop',
    projectId: 'p1',
    score: 10,
  },
  {
    kind: 'content',
    id: 'content:p1:notes.md:4',
    title: 'notes.md',
    snippet: '## **Workshop** launch checklist',
    projectId: 'p1',
    path: 'notes.md',
    source: 'workspace',
    line: 4,
    score: 8,
  },
];

beforeEach(() => {
  vi.mocked(api.search).mockResolvedValue({ results: RESULTS, truncated: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SearchResultsOverlay', () => {
  it('opens from the shared event, requests the full result cap, and highlights matches', async () => {
    render(<SearchResultsOverlay />);

    act(() => openSearchResults('space workshop'));

    expect(screen.getByRole('dialog', { name: 'Search results' })).toBeInTheDocument();
    expect(screen.getByText('Searching…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('2 results')).toBeInTheDocument());
    expect(api.search).toHaveBeenCalledWith('space workshop', {
      mode: 'full',
      maxResults: 100,
    });
    expect(screen.getAllByText(/space|workshop/i, { selector: 'mark' })).toHaveLength(3);
    const snippetMatch = screen
      .getAllByText('Workshop', { selector: 'mark' })
      .find((match) => match.closest('.search-results-snippet'));
    expect(snippetMatch?.closest('strong')).not.toBeNull();
    expect(screen.queryByText('##', { exact: false })).toBeNull();
  });

  it('runs a new search on Enter and closes with Escape', async () => {
    render(<SearchResultsOverlay />);
    act(() => openSearchResults('space'));
    await waitFor(() => expect(screen.getByText('2 results')).toBeInTheDocument());

    const input = screen.getByRole('searchbox', { name: 'Search everything' });
    fireEvent.change(input, { target: { value: 'launch notes' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(api.search).toHaveBeenLastCalledWith('launch notes', {
        mode: 'full',
        maxResults: 100,
      }),
    );
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Search results' })).toBeNull(),
    );
  });

  it('traps keyboard focus and returns it to the launcher when closed', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button" onClick={() => openSearchResults('space')}>
          See all results
        </button>
        <button type="button">Outside action</button>
        <SearchResultsOverlay />
      </>,
    );

    const launcher = screen.getByRole('button', { name: 'See all results' });
    const outsideAction = screen.getByRole('button', { name: 'Outside action' });
    await user.click(launcher);

    const dialog = await screen.findByRole('dialog', { name: 'Search results' });
    const input = screen.getByRole('searchbox', { name: 'Search everything' });
    await waitFor(() => expect(input).toHaveFocus());
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(outsideAction.closest('[aria-hidden="true"]')).not.toBeNull();

    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(outsideAction).not.toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(launcher).toHaveFocus());
  });

  it('distinguishes an incomplete response from an empty successful search', async () => {
    vi.mocked(api.search).mockResolvedValue({
      results: [],
      truncated: false,
      sourcesIncomplete: true,
    });
    render(<SearchResultsOverlay />);

    act(() => openSearchResults('missing'));

    await waitFor(() => expect(screen.getByText('No results.')).toBeInTheDocument());
    expect(screen.getByText(/results may be partial/i)).toBeInTheDocument();
  });
});
