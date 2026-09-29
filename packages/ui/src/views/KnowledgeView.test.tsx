import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

// jsdom can't drive squisq's layout machinery — the view's own logic
// (catalog roster, topic tree, doc list, search, provenance) is the target.
vi.mock('@bendyline/squisq-react', () => ({
  LinearDocView: ({ doc }: { doc: unknown }) => (
    <div data-testid="linear-doc-view">
      {doc ? 'doc' : 'no-doc'}
      <a href="knowledge://gezel-tests/shop-notes/shellac">See shellac</a>
      <a href="https://example.test/outside">Outside</a>
    </div>
  ),
  MediaContext: { Provider: ({ children }: { children: unknown }) => <>{children}</> },
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
  source: 'file' as const,
  updateAvailable: false,
};

const TOPICS = [
  {
    id: 'joinery',
    parentId: null,
    name: 'Joinery',
    description: null,
    sortKey: 'joinery',
    documentCount: 1,
    totalDocumentCount: 2,
  },
  {
    id: 'dovetail-work',
    parentId: 'joinery',
    name: 'Dovetail work',
    description: null,
    sortKey: 'dovetail',
    documentCount: 1,
    totalDocumentCount: 1,
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
  ordinal: null,
  meta: null,
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
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Joinery' }));
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
          uri: 'knowledge://gezel-tests/shop-notes/dovetails',
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

  it('shows subtree totals on topic rows', async () => {
    render(<KnowledgeView />);
    const joinery = (await screen.findByText('Joinery')).closest('button');
    expect(joinery).toHaveTextContent('2');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Joinery' }));
    const shelf = (await screen.findByText('Dovetail work')).closest('button');
    expect(shelf).toHaveTextContent('1');
  });

  it('folds parent topics behind a chevron and remembers what was open', async () => {
    const { unmount } = render(<KnowledgeView />);
    await screen.findByText('Joinery');
    expect(screen.queryByText('Dovetail work')).not.toBeInTheDocument();

    const expand = screen.getByRole('button', { name: 'Expand Joinery' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);
    expect(await screen.findByText('Dovetail work')).toBeInTheDocument();
    const collapse = screen.getByRole('button', { name: 'Collapse Joinery' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(collapse.getAttribute('aria-controls') ?? '')).toContainElement(
      screen.getByText('Dovetail work'),
    );
    expect(screen.queryByRole('button', { name: 'Expand Dovetail work' })).not.toBeInTheDocument();
    unmount();

    render(<KnowledgeView />);
    expect(await screen.findByText('Dovetail work')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Joinery' }));
    expect(screen.queryByText('Dovetail work')).not.toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem('gezel:knowledge:expanded:shop-notes') ?? ''),
    ).toEqual([]);
  });

  it('opens a parent topic when its name is picked, and only the chevron closes it', async () => {
    render(<KnowledgeView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Joinery/ }));
    expect(await screen.findByText('Dovetail work')).toBeInTheDocument();
    await waitFor(() =>
      expect(api.knowledgeCatalogDocuments).toHaveBeenCalledWith(
        'shop-notes',
        expect.objectContaining({ topicId: 'joinery' }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Joinery/ }));
    expect(screen.getByText('Dovetail work')).toBeInTheDocument();
  });

  it('follows a knowledge:// link inside a document and leaves other links alone', async () => {
    render(<KnowledgeView />);
    fireEvent.click(await screen.findByText('Dovetail Joints'));
    expect(await screen.findByTestId('linear-doc-view')).toBeInTheDocument();
    fireEvent.click(screen.getByText('See shellac'));
    await waitFor(() =>
      expect(api.readKnowledgeDocument).toHaveBeenCalledWith('shop-notes', 'shellac'),
    );
    const outside = screen.getByText('Outside');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    outside.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('shows the install pointer when no catalog is registered', async () => {
    vi.mocked(api.listKnowledgeCatalogs).mockResolvedValue({ catalogs: [] });
    render(<KnowledgeView />);
    expect(
      await screen.findByRole('button', { name: 'Open knowledge settings' }),
    ).toBeInTheDocument();
  });

  it('opens the bundled welcome article after a stale catalog selection and allows returning to the list', async () => {
    window.localStorage.setItem('gezel:knowledge:catalog', 'removed-catalog');
    window.localStorage.setItem('gezel:knowledge:document', 'removed-document');
    vi.mocked(api.listKnowledgeCatalogs).mockResolvedValue({
      catalogs: [
        {
          ...CATALOG,
          ref: { ...CATALOG.ref, publisherId: 'bendyline', catalogId: 'handboek' },
          name: 'Gezel Handboek',
          source: 'bundled',
        },
      ],
    });
    render(<KnowledgeView />);
    await waitFor(() =>
      expect(api.readKnowledgeDocument).toHaveBeenCalledWith('handboek', 'welcome'),
    );
    fireEvent.click(screen.getByRole('button', { name: '← Documents' }));
    await waitFor(() =>
      expect(screen.getByTestId('knowledge-view')).toHaveClass('knowledge-view--list'),
    );
  });
});
