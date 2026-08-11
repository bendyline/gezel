import { describe, expect, it, vi } from 'vitest';
import { BLOCKED_REMOTE_MEDIA_URL, createGezelMediaProvider } from './GezelMediaProvider.js';

vi.mock('../api.js', () => ({ api: {} }));

describe('GezelMediaProvider renderer egress', () => {
  it.each([
    'https://attacker.test/pixel?secret=1',
    'http://attacker.test/pixel',
    '//attacker.test/pixel',
    'javascript:alert(1)',
    'file:///tmp/private',
    'custom://handler',
  ])('replaces model-authored external or unsafe media %s', async (source) => {
    const provider = createGezelMediaProvider({ projectId: 'project-1' });
    await expect(provider.resolveUrl(source)).resolves.toBe(BLOCKED_REMOTE_MEDIA_URL);
  });

  it.each(['data:image/png;base64,AA==', 'blob:null/image-id'])(
    'keeps inert in-memory media %s',
    async (source) => {
      const provider = createGezelMediaProvider({ projectId: 'project-1' });
      await expect(provider.resolveUrl(source)).resolves.toBe(source);
    },
  );

  it('leaves an unrecognized relative reference on the local origin', async () => {
    const provider = createGezelMediaProvider({ projectId: 'project-1' });
    await expect(provider.resolveUrl('local/image.png')).resolves.toBe('local/image.png');
  });
});
