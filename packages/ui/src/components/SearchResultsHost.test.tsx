import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { SearchResultsHost } from './SearchResultsHost.js';
import { openSearchResults } from './search-results-open.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

describe('SearchResultsHost', () => {
  it('loads the results overlay on the first open and opens it on that query', async () => {
    const { container } = render(<SearchResultsHost />);
    expect(container).toBeEmptyDOMElement();
    act(() => openSearchResults('invoice'));
    expect(await screen.findByDisplayValue('invoice')).toBeInTheDocument();
  });
});
