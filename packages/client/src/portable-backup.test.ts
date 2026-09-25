import { describe, expect, it } from 'vitest';
import { GezelApiError, GezelClient } from './client.js';

describe('portable backup transport', () => {
  it('sends authenticated binary ZIP content and keeps review separate from confirmation', async () => {
    const calls: Array<{ path: string; request: Request }> = [];
    const client = new GezelClient({
      baseUrl: 'https://local',
      token: 'private',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        calls.push({ path, request });
        if (path.endsWith('/export')) return new Response(new Uint8Array([80, 75, 3, 4]));
        if (path.endsWith('/upload')) return Response.json({ restoreId: 'review-1', items: [] });
        return Response.json({ restored: 1 });
      },
    });
    const bytes = await client.exportPortableBackup({ excludeWorkspaces: true });
    expect(bytes).toEqual(new Uint8Array([80, 75, 3, 4]));
    expect(await client.scanPortableRestore(bytes)).toMatchObject({ restoreId: 'review-1' });
    expect(calls.map((call) => call.path)).toEqual([
      '/api/storage/backup/export',
      '/api/storage/restore/upload',
    ]);
    expect(new Uint8Array(await calls[1]!.request.arrayBuffer())).toEqual(bytes);
    expect(
      calls.every((call) => call.request.headers.get('Authorization') === 'Bearer private'),
    ).toBe(true);
    expect(
      await client.confirmPortableRestore('review-1', {
        items: [{ kind: 'project', id: 'garden', action: 'replace' }],
      }),
    ).toEqual({ restored: 1 });
    expect(calls.at(-1)?.path).toBe('/api/storage/restore/review-1/confirm');
  });
  it('does not return archive bytes or a successful review when the host rejects them', async () => {
    const client = new GezelClient({
      baseUrl: 'https://local',
      token: 'private',
      fetch: async () => new Response('Archive too large', { status: 413 }),
    });
    for (const [result, message] of [
      [client.exportPortableBackup(), 'Could not export the backup'],
      [client.scanPortableRestore(new Uint8Array()), 'Could not inspect the backup'],
    ] as const) {
      await expect(result).rejects.toBeInstanceOf(GezelApiError);
      await expect(result).rejects.toMatchObject({
        message,
        status: 413,
        details: 'Archive too large',
      });
    }
  });
});
