import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { SearchResultsHost } from './SearchResultsHost.js';
import { openSearchResults } from './search-results-open.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

// The overlay is lazy(). Loaded cold inside the test, its module graph is
// transformed while findBy's clock runs, which passed its 5 s in the full
// suite. Collection has no clock; the lazy() then resolves from the cache.
await import('./SearchResultsOverlay.js');

describe('SearchResultsHost', () => {
  it('loads the results overlay on the first open and opens it on that query', async () => {
    const { container } = render(<SearchResultsHost />);
    expect(container).toBeEmptyDOMElement();
    await act(async () => openSearchResults('invoice'));
    expect(await screen.findByDisplayValue('invoice')).toBeInTheDocument();
  });
});
