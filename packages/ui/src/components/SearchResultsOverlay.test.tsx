import type { UnifiedSearchResult } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    snippet: 'Workshop launch checklist',
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
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search results' })).toBeNull();
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
