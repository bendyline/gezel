import { describe, expect, it, vi } from 'vitest';
import { PortableProductService } from '../../core/src/runtime/product-service.js';
import { portableFixture } from '../../core/src/runtime/test-files.js';
import { createOfflineHtmlPreview } from '../../mobile/src/html-preview.js';

describe('native preview reads through the actual portable service', () => {
  it.each(['artifacts', 'workspace'] as const)(
    'reads HTML and relative binary assets from %s',
    async (source) => {
      const { store } = portableFixture();
      const service = new PortableProductService(
        store,
        {
          providers: async () => [],
          generate: async () => ({ text: '', stopReason: 'stop' }),
          cancel: async () => {},
        },
        'preview-secret',
      );
      await service.initialize();
      const headers = { Authorization: 'Bearer preview-secret' };
      for (const [path, content] of [
        ['page/index.html', '<img src="icon.svg"><script>window.loaded=true</script>'],
        ['page/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ]) {
        const response = await service.fetch(
          `https://gezel.local/api/projects/default/${source}/raw?path=${encodeURIComponent(path!)}`,
          { method: 'PUT', headers, body: content },
        );
        expect(response.status).toBe(200);
      }
      const publish = vi.fn(async (_html: string) => ({
        url: 'capacitor://localhost/__gezel_preview/id/index.html',
        dispose: () => {},
      }));
      const preview = createOfflineHtmlPreview(service.fetch, 'preview-secret', publish);
      await preview({ projectId: 'default', source, path: 'page/index.html' });
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0]![0]).toContain('data:image/svg+xml;base64,');
      expect(publish.mock.calls[0]![0]).not.toContain('preview-secret');
      expect(publish.mock.calls[0]![0]).not.toContain('blob:');
      await expect(
        createOfflineHtmlPreview(
          service.fetch,
          'wrong',
          publish,
        )({ projectId: 'default', source, path: 'page/index.html' }),
      ).rejects.toThrow('(401)');
    },
  );
});
