import { describe, expect, it, vi } from 'vitest';
import type { MobileProviderId } from '../schemas/mobile-provider.js';
import { type PortableInference, PortableProductService } from './product-service.js';
import { portableFixture } from './test-files.js';

async function fixture(providerId: MobileProviderId, model: string) {
  const { store } = portableFixture();
  const inference: PortableInference = {
    providers: async () => [
      {
        id: providerId,
        name: 'System model',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 4096,
        maxOutputTokens: 1024,
        capabilities: {
          text: true,
          tools: false,
          images: false,
          structuredOutput: false,
          foregroundOnly: true,
        },
      },
    ],
    generate: vi.fn(async () => ({ text: 'Done', stopReason: 'stop' as const })),
    cancel: vi.fn(async () => {}),
  };
  const service = new PortableProductService(store, inference, 'secret');
  await service.initialize();
  const gezel = await store.createGezel({
    name: 'Iris',
    role: 'Klerk',
    frontmatter: { provider: providerId, model },
  });
  await store.writeConfig({ klerkGezelId: gezel.id });
  const session = await store.createSession({ gezelId: gezel.id, providerName: providerId, model });
  const request = (path: string, body: unknown) =>
    service.fetch(`https://gezel.local${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { store, gezel, session, service, inference, request };
}

describe.each(['apple-foundation-models', 'android-mlkit'] as const)(
  '%s model admission',
  (providerId) => {
    it('rejects a restored conversation with a model from another provider before saving or inference', async () => {
      const f = await fixture(providerId, 'model-from-another-provider');
      const response = await f.request(`/api/sessions/${f.session.id}/send`, {
        message: 'Continue',
      });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('conversation model is not available');
      expect(f.inference.generate).not.toHaveBeenCalled();
      expect((await f.store.getSession(f.gezel.id, f.session.id))?.messages).toEqual([]);
      expect(f.service.busy).toBe(false);
    });

    it('rejects an unavailable configured Klerk model without silently using the system default', async () => {
      const f = await fixture(providerId, 'model-from-another-provider');
      const response = await f.request('/api/ai/transform', {
        mode: 'rewrite',
        text: 'A rough paragraph.',
      });
      expect(response.status).toBe(200);
      const events = await response.text();
      expect(events).toContain('Klerk model is not available');
      expect(events).toContain('"type":"error"');
      expect(f.inference.generate).not.toHaveBeenCalled();
      expect(f.service.busy).toBe(false);
    });

    it('keeps the explicitly selected system model for a configured Klerk', async () => {
      const f = await fixture(providerId, providerId);
      const response = await f.request('/api/ai/transform', {
        mode: 'rewrite',
        text: 'A rough paragraph.',
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Done');
      expect(f.inference.generate).toHaveBeenCalledWith(
        expect.objectContaining({ providerId, modelId: providerId }),
        expect.any(Function),
      );
    });
  },
);
