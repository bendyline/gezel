import { describe, expect, it, vi } from 'vitest';

const fetchKnowledgeAsset = vi.fn(async (_catalogId: string, path: string) => {
  await new Promise((r) => setTimeout(r, 5));
  return new Blob([path], { type: 'image/png' });
});
vi.mock('../../api.js', () => ({ api: { fetchKnowledgeAsset } }));

const created: Blob[] = [];
const revoked: string[] = [];
Object.assign(URL, {
  createObjectURL: vi.fn((blob: Blob) => {
    created.push(blob);
    return `blob:mock-${created.length}`;
  }),
  revokeObjectURL: vi.fn((url: string) => {
    revoked.push(url);
  }),
});

const { createKnowledgeMediaProvider } = await import('./KnowledgeMediaProvider.js');

describe('createKnowledgeMediaProvider', () => {
  it('resolves catalog assets to blob URLs through the authenticated client', async () => {
    const provider = createKnowledgeMediaProvider({ catalogId: 'notes', version: '1.0.0' });
    const url = await provider.resolveUrl('assets/mark.png');
    expect(url).toMatch(/^blob:/);
    expect(fetchKnowledgeAsset).toHaveBeenCalledWith('notes', 'assets/mark.png', {
      version: '1.0.0',
    });
    expect(created.at(-1)?.type).toBe('image/png');
  });

  it('coalesces concurrent fetches of one path and caches the result', async () => {
    fetchKnowledgeAsset.mockClear();
    const provider = createKnowledgeMediaProvider({ catalogId: 'notes' });
    const [a, b] = await Promise.all([
      provider.resolveUrl('./assets/flow.png'),
      provider.resolveUrl('assets/flow.png'),
    ]);
    expect(a).toBe(b);
    expect(await provider.resolveUrl('assets/flow.png')).toBe(a);
    expect(fetchKnowledgeAsset).toHaveBeenCalledTimes(1);
    expect(fetchKnowledgeAsset).toHaveBeenCalledWith('notes', 'assets/flow.png', {});
  });

  it('passes non-asset references through and survives a failed fetch', async () => {
    const provider = createKnowledgeMediaProvider({ catalogId: 'notes' });
    expect(await provider.resolveUrl('https://example.com/x.png')).toBe(
      'https://example.com/x.png',
    );
    expect(await provider.resolveUrl('poppetje/adam.headshot.svg')).toBe(
      'poppetje/adam.headshot.svg',
    );
    fetchKnowledgeAsset.mockRejectedValueOnce(new Error('404'));
    expect(await provider.resolveUrl('assets/missing.png')).toBe('assets/missing.png');
  });

  it('revokes every blob URL on dispose', async () => {
    const provider = createKnowledgeMediaProvider({ catalogId: 'notes' });
    const url = await provider.resolveUrl('assets/a.png');
    provider.dispose?.();
    expect(revoked).toContain(url);
  });
});
