import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { PreviewCapabilityStore } from '../preview-capability.js';
import { pageCheckRoutes } from './page-check.js';

const seen = vi.hoisted(() => ({ url: '' }));

// The page under test prints its own URL into the errors the gezel reads,
// once plainly and once encoded. A gezel once learned a live preview
// capability this way and put a link to it in chat.
vi.mock('../../page-check/runner.js', () => ({
  resolvePlaywrightInstall: async () => '/playwright',
  isChromiumReady: async () => true,
  runPageCheck: async ({ url }: { url: string }) => {
    seen.url = url;
    return {
      ran: true,
      ok: false,
      errors: [`console.error: ${url}`, `console.error: ${Buffer.from(url).toString('base64')}`],
    };
  },
}));

describe('POST /:id/page-check and the capability it mints', () => {
  it('revokes the lease before answering and redacts the plain URL', async () => {
    const capabilities = new PreviewCapabilityStore();
    const ctx = {
      home: '/nonexistent-home',
      store: { getProject: async () => ({ id: 'p1' }) },
    } as unknown as Parameters<typeof pageCheckRoutes>[0];
    const app = new Hono();
    app.route('/api/projects', pageCheckRoutes(ctx, capabilities));

    const res = await app.request('/api/projects/p1/page-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'report/index.html' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors: string[] };

    const token = decodeURIComponent(seen.url.split('/preview/')[1]?.split('/')[0] ?? '');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.errors[0]).not.toContain(token);
    // The encoded copy cannot be scrubbed; the revoked lease is what matters.
    expect(
      capabilities.authorize({
        token,
        source: 'workspace',
        projectId: 'p1',
        path: 'report/index.html',
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });
});
