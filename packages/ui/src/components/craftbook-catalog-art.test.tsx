import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  books: [] as string[],
  calls: 0,
}));

vi.mock('../api.js', () => ({
  api: {
    listProjectCraftbooks: async () => {
      state.calls += 1;
      return {
        items: state.books.map((id) => ({
          sourceId: 'bundled',
          kind: 'craftbook-template',
          manifest: { kind: 'craftbook-template', id, name: id },
        })),
      };
    },
  },
}));

const { useCraftbookCatalogLookup } = await import('./craftbook-catalog-art.js');

describe('useCraftbookCatalogLookup', () => {
  beforeEach(() => {
    state.books = [];
    state.calls = 0;
  });

  it('asks again when a cached listing predates the book', async () => {
    // A book written or installed after the first listing used to hold the
    // composer's Send on "Loading the craftbook…" until a restart.
    state.books = ['deck'];
    const first = renderHook(() => useCraftbookCatalogLookup('p-new-book', 'deck'));
    await waitFor(() => expect(first.result.current.status).toBe('found'));

    state.books = ['deck', 'fresh-book'];
    const { result } = renderHook(() => useCraftbookCatalogLookup('p-new-book', 'fresh-book'));
    await waitFor(() => expect(result.current.status).toBe('found'));
    expect(result.current.art?.manifest.id).toBe('fresh-book');
    expect(state.calls).toBe(2);
  });

  it('reports a book that a fresh listing does not have as missing', async () => {
    state.books = ['deck'];
    const { result } = renderHook(() => useCraftbookCatalogLookup('p-missing', 'gone'));
    await waitFor(() => expect(result.current.status).toBe('missing'));
    expect(result.current.art).toBeNull();
    expect(state.calls).toBe(1);
  });
});
