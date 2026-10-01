/** Binary artifact writes retain transport diagnostics without replaying a
 * possibly successful upload. The caller owns any idempotent recovery policy.
 */
import { describe, expect, it, vi } from 'vitest';
import { describeTransportError } from './api-error.js';
import { GezelApiError, GezelClient } from './client.js';

describe('binary artifact upload failures', () => {
  const path = '/api/projects/p/artifacts/raw?path=images%2Foriginal.jpg&create=1';
  const socketFailure = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
  it.each(['headers', 'body'])(
    'retains the nested connection cause during %s without replay',
    async (phase) => {
      const fetchImpl = vi.fn().mockImplementation(async () => {
        if (phase === 'headers') throw socketFailure();
        return {
          ok: true,
          json: async () => {
            throw socketFailure();
          },
        };
      });
      const client = new GezelClient({ baseUrl: 'http://test', token: 'secret', fetch: fetchImpl });
      const error = await client
        .writeProjectArtifactBinary(
          'p',
          'images/original.jpg',
          new Uint8Array([1, 2]),
          'image/jpeg',
          { createOnly: true },
        )
        .catch((error) => error);
      expect(error).toBeInstanceOf(GezelApiError);
      expect(error.status).toBe(0);
      expect(error.message).toContain(`Gezel API transport unavailable on PUT ${path}`);
      expect(error.details).toMatchObject({ kind: 'transport', causeName: 'TypeError' });
      expect(error.details.cause).toContain('UND_ERR_SOCKET');
      expect(error.message).not.toContain('secret');
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[1].method).toBe('PUT');
    },
  );
  it('preserves HTTP rejection status without calling it a transport failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });
    const error = await client
      .writeProjectArtifactBinary('p', 'image.jpg', new Uint8Array([1]), 'image/jpeg')
      .catch((error) => error);
    expect(error).toBeInstanceOf(GezelApiError);
    expect(error.status).toBe(403);
    expect(error.details).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('does not classify malformed JSON as a connection failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('broken json'));
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });
    await expect(
      client.writeProjectArtifactBinary('p', 'image.jpg', new Uint8Array([1]), 'image/jpeg'),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('nested transport diagnostics', () => {
  it('includes nested codes even when the messages do not name them', () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const error = new TypeError('fetch failed', {
      cause: new Error('upload interrupted', { cause }),
    });
    expect(describeTransportError(error)).toBe(
      'fetch failed (upload interrupted; UND_ERR_SOCKET: other side closed)',
    );
  });
  it('terminates cyclic causes without duplicating the same message', () => {
    const error = new Error('ECONNRESET') as Error & { code: string };
    error.code = 'ECONNRESET';
    error.cause = error;
    expect(describeTransportError(error)).toBe('ECONNRESET');
  });
});
