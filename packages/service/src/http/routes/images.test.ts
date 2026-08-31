import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { imagesRoutes } from './images.js';

function context(store: Record<string, unknown>): ServiceContext {
  return { store } as unknown as ServiceContext;
}

describe('project attachment routes', () => {
  it('accepts a document and preserves its original filename for storage', async () => {
    const writeProjectAttachment = vi.fn(async () => ({
      relativePath: 'attachments/generated.pdf',
      filename: 'generated.pdf',
    }));
    const app = imagesRoutes(context({ writeProjectAttachment }));

    const response = await app.request('/default/attachments?filename=design_brief.pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });

    expect(response.status).toBe(200);
    expect(writeProjectAttachment).toHaveBeenCalledWith(
      'default',
      expect.any(Buffer),
      'application/pdf',
      'design_brief.pdf',
    );
    await expect(response.json()).resolves.toMatchObject({
      relativePath: 'attachments/generated.pdf',
    });
  });

  it('serves non-image attachments as downloads', async () => {
    const app = imagesRoutes(
      context({
        readProjectAttachment: vi.fn(async () => ({
          data: Buffer.from('document'),
          mimeType: 'application/pdf',
        })),
      }),
    );

    const response = await app.request('/default/attachments/design.pdf');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
  });

  it('keeps the legacy session upload endpoint image-only', async () => {
    const app = imagesRoutes(context({}));

    const response = await app.request('/default/sessions/session-1/images', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array([1]),
    });

    expect(response.status).toBe(415);
  });
});
