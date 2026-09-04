import type { CatalogItemSummary } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { KnowledgeCatalogsCard } = await import('./KnowledgeCatalogsCard.js');
const { api } = await import('../api.js');
const { MODEL_INVENTORY_CHANGED_EVENT } = await import('../model-inventory.js');

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
  documents: 4,
  sizeBytes: 2 * 1024 * 1024,
  source: 'file' as const,
  updateAvailable: false,
};

const DONE = {
  type: 'done' as const,
  ref: CATALOG.ref,
  rootDir: '/tmp/shop-notes',
  storageScope: 'user' as const,
};

const HF = {
  repo: 'Bendyline/wikipedia-physics',
  revision: 'a'.repeat(40),
  path: 'releases/2026.9.1/wikipedia-physics-2026.9.1.gezk',
};

const OFFERED = {
  id: 'wikipedia-physics',
  publisherId: 'bendyline',
  name: 'Wikipedia: Physics',
  description: 'Physics reference articles.',
  tags: ['wikipedia'],
  language: 'en',
  license: 'CC BY-SA 4.0',
  version: '2026.9.1',
  releasedAt: '2026-09-01T00:00:00.000Z',
  formatVersion: '0.5',
  huggingface: HF,
  sha256: 'b'.repeat(64),
  archiveBytes: 900 * 1024 * 1024,
  uncompressedBytes: 1_500_000_000,
  documents: 57_210,
  chunks: 199_481,
  embeddingProfile: { id: 'multilingual-e5-small@1', modelRepo: 'Xenova/multilingual-e5-small' },
  topics: [{ id: 'physics', name: 'Physics' }],
  sharedOnDevice: false,
  installing: false,
  incompleteDownload: false,
};

const OFFERED_ITEM = {
  sourceId: 'bundled',
  kind: 'knowledge-catalog',
  manifest: {
    schemaVersion: 1,
    kind: 'knowledge-catalog',
    id: OFFERED.id,
    name: OFFERED.name,
    description: OFFERED.description,
    tags: OFFERED.tags,
    maintainer: { name: 'Bendyline' },
    license: OFFERED.license,
    yankedVersions: [],
    publisherId: OFFERED.publisherId,
    language: OFFERED.language,
    version: OFFERED.version,
    releasedAt: OFFERED.releasedAt,
    formatVersion: OFFERED.formatVersion,
    huggingface: HF,
    sha256: OFFERED.sha256,
    archiveBytes: OFFERED.archiveBytes,
    uncompressedBytes: OFFERED.uncompressedBytes,
    documents: OFFERED.documents,
    chunks: OFFERED.chunks,
    embeddingProfile: OFFERED.embeddingProfile,
    topics: OFFERED.topics,
    availableVersions: [OFFERED.version],
  },
} as unknown as CatalogItemSummary;

function announcedKnowledgeChange(): { fired: () => boolean; dispose: () => void } {
  let fired = false;
  const listener = (event: Event) => {
    if ((event as CustomEvent<{ engine?: string }>).detail?.engine === 'knowledge') fired = true;
  };
  window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, listener);
  return {
    fired: () => fired,
    dispose: () => window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, listener),
  };
}

beforeEach(() => {
  vi.mocked(api.listKnowledgeCatalogs).mockResolvedValue({ catalogs: [CATALOG] });
  vi.mocked(api.listAvailableKnowledgeCatalogs).mockResolvedValue({ catalogs: [] });
  vi.mocked(api.listIncompleteKnowledgeDownloads).mockResolvedValue({ incomplete: [] });
  vi.mocked(api.listKnowledgeActiveInstalls).mockResolvedValue({ installs: [] });
  vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [] });
  vi.mocked(api.updateKnowledgeCatalog).mockResolvedValue({ ok: true });
  vi.mocked(api.removeKnowledgeCatalog).mockResolvedValue({ ok: true });
  vi.mocked(api.cancelKnowledgeJob).mockResolvedValue({ cancelled: true });
  vi.mocked(api.deleteIncompleteKnowledgeDownload).mockResolvedValue({ ok: true });
  vi.mocked(api.installKnowledgeCatalog).mockResolvedValue({
    jobId: 'job-1',
    alreadyRunning: false,
  });
  vi.mocked(api.subscribeKnowledgeInstall).mockImplementation(async (_jobId, onEvent) => {
    onEvent(DONE);
  });
  vi.mocked(api.installKnowledgeCatalogFromCatalog).mockImplementation(async (id, onEvent) => {
    onEvent({ type: 'progress', phase: 'download', bytesDone: 50, bytesTotal: 100 });
    onEvent({ ...DONE, ref: { ...DONE.ref, publisherId: 'bendyline', catalogId: id } });
  });
});

describe('KnowledgeCatalogsCard', () => {
  it('hides Install until the source is a valid catalog path or URL', async () => {
    render(<KnowledgeCatalogsCard />);
    const input = await screen.findByLabelText('Catalog file path or URL');

    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'notes.txt' } });
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'https:/example.test/notes.gezk' } });
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '/catalogs/notes.gezk' } });
    expect(screen.getByRole('button', { name: 'Install' })).toBeVisible();
  });

  it('lists installed catalogs with their state', async () => {
    render(<KnowledgeCatalogsCard />);
    expect(await screen.findByText('Shop Notes')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '4' })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('Only for you')).toBeInTheDocument();
  });

  it('shows the quarantine reason verbatim', async () => {
    vi.mocked(api.listKnowledgeCatalogs).mockResolvedValue({
      catalogs: [{ ...CATALOG, enabled: false, mounted: false, disabledReason: 'sha mismatch' }],
    });
    render(<KnowledgeCatalogsCard />);
    expect(await screen.findByText(/quarantined — sha mismatch/)).toBeInTheDocument();
  });

  it('starts a file install, follows its job stream and announces the inventory change', async () => {
    const changed = announcedKnowledgeChange();
    render(<KnowledgeCatalogsCard />);
    const input = await screen.findByLabelText('Catalog file path or URL');
    fireEvent.change(input, { target: { value: 'C:\\catalogs\\notes.gezk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(api.installKnowledgeCatalog).toHaveBeenCalledWith({
        source: { kind: 'file', path: 'C:\\catalogs\\notes.gezk' },
      }),
    );
    await waitFor(() =>
      expect(api.subscribeKnowledgeInstall).toHaveBeenCalledWith(
        'job-1',
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(changed.fired()).toBe(true));
    changed.dispose();
  });

  it('URL sources install as url kind', async () => {
    render(<KnowledgeCatalogsCard />);
    const input = await screen.findByLabelText('Catalog file path or URL');
    fireEvent.change(input, { target: { value: 'https://example.test/notes.gezk' } });
    fireEvent.change(screen.getByLabelText('Catalog SHA-256 digest'), {
      target: { value: 'b'.repeat(64) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(api.installKnowledgeCatalog).toHaveBeenCalledWith({
        source: {
          kind: 'url',
          url: 'https://example.test/notes.gezk',
          expectedSha256: 'b'.repeat(64),
        },
      }),
    );
  });

  it('requires a publisher digest for URL installs', async () => {
    render(<KnowledgeCatalogsCard />);
    const input = await screen.findByLabelText('Catalog file path or URL');
    fireEvent.change(input, { target: { value: 'https://example.test/notes.gezk' } });
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    expect(screen.getByText(/installed only when their bytes match/i)).toBeInTheDocument();
  });

  it('disable saves through the API', async () => {
    render(<KnowledgeCatalogsCard />);
    const toggle = await screen.findByRole('checkbox');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.updateKnowledgeCatalog).toHaveBeenCalledWith('shop-notes', { enabled: false }),
    );
  });

  it('remove requires confirmation', async () => {
    render(<KnowledgeCatalogsCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(api.removeKnowledgeCatalog).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove catalog' }));
    await waitFor(() => expect(api.removeKnowledgeCatalog).toHaveBeenCalledWith('shop-notes'));
  });

  it('offers catalog downloads and streams the install like a model download', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [OFFERED_ITEM] });
    vi.mocked(api.listAvailableKnowledgeCatalogs).mockResolvedValue({ catalogs: [OFFERED] });
    const changed = announcedKnowledgeChange();
    render(<KnowledgeCatalogsCard />);
    expect(await screen.findByText('Wikipedia: Physics')).toBeInTheDocument();
    expect(screen.getByText('Published by')).toBeInTheDocument();
    expect(screen.getByText(/57,210 documents/)).toBeInTheDocument();
    const link = screen.getByTitle('View Bendyline/wikipedia-physics on Hugging Face');
    expect(link).toHaveAttribute(
      'href',
      'https://huggingface.co/datasets/Bendyline/wikipedia-physics',
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(api.installKnowledgeCatalogFromCatalog).toHaveBeenCalledWith(
        'wikipedia-physics',
        expect.any(Function),
        expect.any(AbortSignal),
        undefined,
      ),
    );
    await waitFor(() => expect(changed.fired()).toBe(true));
    changed.dispose();
  });

  it('reflects installed, updatable and partially downloaded catalog entries', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [OFFERED_ITEM] });
    const installed = {
      version: '2026.8.1',
      contentDigest: 'c'.repeat(64),
      storageScope: 'user' as const,
      enabled: true,
      updateAvailable: false,
    };
    vi.mocked(api.listAvailableKnowledgeCatalogs).mockResolvedValue({
      catalogs: [{ ...OFFERED, installed }],
    });
    const { unmount } = render(<KnowledgeCatalogsCard />);
    expect(await screen.findByRole('button', { name: 'Installed' })).toBeDisabled();
    unmount();

    vi.mocked(api.listAvailableKnowledgeCatalogs).mockResolvedValue({
      catalogs: [{ ...OFFERED, installed: { ...installed, updateAvailable: true } }],
    });
    const second = render(<KnowledgeCatalogsCard />);
    expect(await screen.findByRole('button', { name: 'Update to v2026.9.1' })).toBeEnabled();
    second.unmount();

    vi.mocked(api.listAvailableKnowledgeCatalogs).mockResolvedValue({
      catalogs: [{ ...OFFERED, incompleteDownload: true }],
    });
    render(<KnowledgeCatalogsCard />);
    expect(await screen.findByRole('button', { name: 'Resume download' })).toBeEnabled();
  });

  it('lists partial downloads with resume and delete', async () => {
    vi.mocked(api.listIncompleteKnowledgeDownloads).mockResolvedValue({
      incomplete: [
        {
          key: 'b'.repeat(16),
          bytes: 300 * 1024 * 1024,
          updatedAt: '2026-09-01T00:00:00.000Z',
          resumable: true,
          catalogId: 'wikipedia-physics',
          name: 'Wikipedia: Physics',
          archiveBytes: OFFERED.archiveBytes,
        },
      ],
    });
    render(<KnowledgeCatalogsCard />);
    expect(await screen.findByText('Incomplete downloads')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(api.installKnowledgeCatalogFromCatalog).toHaveBeenCalledWith(
        'wikipedia-physics',
        expect.any(Function),
        expect.any(AbortSignal),
        undefined,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(api.deleteIncompleteKnowledgeDownload).toHaveBeenCalledWith('b'.repeat(16)),
    );
  });

  it('explains a network-blocked install in terms of the security policy', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [OFFERED_ITEM] });
    vi.mocked(api.listAvailableKnowledgeCatalogs).mockResolvedValue({ catalogs: [OFFERED] });
    vi.mocked(api.installKnowledgeCatalogFromCatalog).mockRejectedValue(
      new GezelApiError('network-blocked', 403),
    );
    render(<KnowledgeCatalogsCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect((await screen.findAllByText(/app network access/)).length).toBeGreaterThan(0);
  });
});
