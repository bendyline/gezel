import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { KnowledgeCatalogsCard } = await import('./KnowledgeCatalogsCard.js');
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
  documents: 4,
  sizeBytes: 2 * 1024 * 1024,
};

beforeEach(() => {
  vi.mocked(api.listKnowledgeCatalogs).mockResolvedValue({ catalogs: [CATALOG] });
  vi.mocked(api.updateKnowledgeCatalog).mockResolvedValue({ ok: true });
  vi.mocked(api.removeKnowledgeCatalog).mockResolvedValue({ ok: true });
  vi.mocked(api.installKnowledgeCatalog).mockResolvedValue({ jobId: 'job-1' });
  vi.mocked(api.getKnowledgeJob).mockResolvedValue({
    id: 'job-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finished: true,
    events: [{ type: 'done' }],
  });
});

describe('KnowledgeCatalogsCard', () => {
  it('lists installed catalogs with their state', async () => {
    render(<KnowledgeCatalogsCard />);
    expect(await screen.findByText('Shop Notes')).toBeInTheDocument();
    expect(screen.getByText(/4 documents/)).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('shows the quarantine reason verbatim', async () => {
    vi.mocked(api.listKnowledgeCatalogs).mockResolvedValue({
      catalogs: [{ ...CATALOG, enabled: false, mounted: false, disabledReason: 'sha mismatch' }],
    });
    render(<KnowledgeCatalogsCard />);
    expect(await screen.findByText(/quarantined — sha mismatch/)).toBeInTheDocument();
  });

  it('starts a file install and announces the registry change', async () => {
    const changed = vi.fn();
    window.addEventListener('gezel:knowledge-catalogs-updated', changed);
    render(<KnowledgeCatalogsCard />);
    const input = await screen.findByLabelText('Catalog file path or URL');
    fireEvent.change(input, { target: { value: 'C:\\catalogs\\notes.gezk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(api.installKnowledgeCatalog).toHaveBeenCalledWith({
        source: { kind: 'file', path: 'C:\\catalogs\\notes.gezk' },
      }),
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener('gezel:knowledge-catalogs-updated', changed);
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
});
