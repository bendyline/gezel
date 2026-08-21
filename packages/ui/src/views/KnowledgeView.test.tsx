import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

// jsdom can't drive squisq's layout machinery — the view's own logic
// (catalog roster, topic tree, doc list, search, provenance) is the target.
vi.mock('@bendyline/squisq-react', () => ({
  LinearDocView: ({ doc }: { doc: unknown }) => (
    <div data-testid="linear-doc-view">{doc ? 'doc' : 'no-doc'}</div>
  ),
}));

const { KnowledgeView } = await import('./KnowledgeView.js');
const { api } = await import('../api.js');

const CATALOG = {
  ref: {
    publisherId: 'gezel-tests',
    catalogId: 'shop-notes',
    version: '1.0.0',
    contentDigest: 'a'.repeat(64),
    storageScope: 'user' as const,
  },
  enabled: true,
  addedAt: '2026-01-01T00:00:00.000Z',
  mounted: true,
  name: 'Shop Notes',
  license: 'MIT',
  documents: 2,
};

const TOPICS = [
  {
    id: 'joinery',
    parentId: null,
    name: 'Joinery',
    description: null,
    sortKey: 'joinery',
    documentCount: 2,
  },
  {
    id: 'dovetail-work',
    parentId: 'joinery',
    name: 'Dovetail work',
    description: null,
    sortKey: 'dovetail',
    documentCount: 1,
  },
];

const DOC_META = {
  id: 'dovetails',
  title: 'Dovetail Joints',
  slug: 'dovetails',
  summary: 'Interlocking corners.',
  language: 'en',
  topicId: 'joinery',
  sourceUrl: 'https://example.test/dovetails',
  sourceRevision: null,
  sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
  attribution: null,
};

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.listKnowledgeCatalogs).mockResolvedValue({ catalogs: [CATALOG] });
  vi.mocked(api.knowledgeCatalogTopics).mockResolvedValue({ topics: TOPICS });
  vi.mocked(api.knowledgeCatalogDocuments).mockResolvedValue({
    documents: [DOC_META],
    total: 1,
  });
  vi.mocked(api.readKnowledgeDocument).mockResolvedValue({
    ...DOC_META,
    markdown: '# Dovetail Joints\n\nTails and pins.',
  });
  vi.mocked(api.searchKnowledge).mockResolvedValue({ results: [] });
});

describe('KnowledgeView', () => {
  it('renders the catalog TOC and opens a document with provenance', async () => {
    render(<KnowledgeView />);
    expect(await screen.findByText('Shop Notes')).toBeInTheDocument();
    expect(await screen.findByText('Joinery')).toBeInTheDocument();
    expect(await screen.findByText('Dovetail work')).toBeInTheDocument();

    fireEvent.click(await screen.findByText('Dovetail Joints'));
    await waitFor(() =>
      expect(api.readKnowledgeDocument).toHaveBeenCalledWith('shop-notes', 'dovetails'),
    );
    expect(await screen.findByTestId('linear-doc-view')).toHaveTextContent('doc');
    expect(screen.getByRole('button', { name: 'Copy citation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open source' })).toBeInTheDocument();
  });

  it('search answers the keystroke and lists cited results', async () => {
    vi.mocked(api.searchKnowledge).mockResolvedValue({
      results: [
        {
          kind: 'knowledge',
          id: 'knowledge:shop-notes:abc',
          title: 'Dovetail Joints',
          snippet: 'Tails and pins interlock…',
          documentId: 'dovetails',
          catalogId: 'shop-notes',
          uri: 'knowledge://shop-notes/dovetails',
          relevance: 0.8,
          tier: 'strong',
          score: 296,
        },
      ],
    });
    render(<KnowledgeView />);
    const box = await screen.findByLabelText('Search knowledge');
    fireEvent.change(box, { target: { value: 'dovetail' } });
    expect(await screen.findByText('Search results')).toBeInTheDocument();
    await waitFor(() => expect(api.searchKnowledge).toHaveBeenCalled());
    expect(await screen.findByText('Tails and pins interlock…')).toBeInTheDocument();
  });

  it('shows the install pointer when no catalog is registered', async () => {
    vi.mocked(api.listKnowledgeCatalogs).mockResolvedValue({ catalogs: [] });
    render(<KnowledgeView />);
    expect(
      await screen.findByRole('button', { name: 'Open knowledge settings' }),
    ).toBeInTheDocument();
  });
});
