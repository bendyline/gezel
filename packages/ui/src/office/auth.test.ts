import { describe, expect, it } from 'vitest';
import { paneErrorMessage, registerPane, waitForGrant } from './auth.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function scripted(answers: Array<() => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next();
  }) as typeof fetch;
  return { deps: { fetch: fetchImpl, baseUrl: 'https://localhost:4000' }, calls };
}

describe('waitForGrant', () => {
  it('keeps polling after the connection drops, as it does when the computer sleeps', async () => {
    const slept: number[] = [];
    const { deps, calls } = scripted([
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => json({ error: 'service unavailable' }, 503),
      () => json({ status: 'pending' }),
      () => json({ status: 'approved', token: 'tok' }),
    ]);
    const outcome = await waitForGrant(deps, 'g1', {
      sleep: async (ms) => void slept.push(ms),
    });
    expect(outcome).toEqual({ kind: 'approved', token: 'tok' });
    expect(calls).toHaveLength(4);
    expect(slept).toEqual([1_000, 2_000]);
  });

  it('still gives up at the deadline', async () => {
    let t = 0;
    const { deps } = scripted(
      Array.from({ length: 50 }, () => () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const outcome = await waitForGrant(deps, 'g1', {
      timeoutMs: 10_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(outcome).toEqual({ kind: 'timeout' });
  });

  it('reports an expired request without retrying', async () => {
    const { deps, calls } = scripted([() => json({ error: 'not_found' }, 404)]);
    expect(await waitForGrant(deps, 'g1', { sleep: async () => undefined })).toEqual({
      kind: 'expired',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('paneErrorMessage', () => {
  it("uses the daemon's sentence, never a status line or a code", () => {
    expect(paneErrorMessage(409, { error: 'conflict', message: 'Office is already set up.' })).toBe(
      'Office is already set up.',
    );
    expect(paneErrorMessage(400, { error: 'That folder is not readable.' })).toBe(
      'That folder is not readable.',
    );
    expect(paneErrorMessage(500, { error: 'internal_error' })).toMatch(/^Gezel ran into a problem/);
    expect(paneErrorMessage(403, {})).toMatch(/^Gezel could not connect this document/);
    expect(paneErrorMessage(500, {})).not.toMatch(/500/);
  });

  it('is what a refused registration shows', async () => {
    const { deps } = scripted([() => json({ error: 'internal_error' }, 500)]);
    const result = await registerPane(deps);
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' && result.message).not.toMatch(/answered|500/);
  });
});
