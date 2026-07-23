import { describe, expect, it } from 'vitest';
import { fetchHuggingfaceCommit } from './hf-api.js';

describe('fetchHuggingfaceCommit', () => {
  it('resolves a ref to its commit sha via /revision/<rev>', async () => {
    const sha = `${'0'.repeat(39)}a`;
    let requestedUrl = '';
    const fetchImpl = (async (input: string | URL) => {
      requestedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify({ id: 'org/repo', sha }), { status: 200 });
    }) as typeof fetch;

    const got = await fetchHuggingfaceCommit('org/repo', { rev: 'main', fetchImpl });
    expect(got).toBe(sha);
    expect(requestedUrl).toBe('https://huggingface.co/api/models/org/repo/revision/main');
  });

  it('defaults the ref to main', async () => {
    const sha = 'b'.repeat(40);
    let requestedUrl = '';
    const fetchImpl = (async (input: string | URL) => {
      requestedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify({ sha }), { status: 200 });
    }) as typeof fetch;

    await fetchHuggingfaceCommit('org/repo', { fetchImpl });
    expect(requestedUrl).toContain('/revision/main');
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await expect(fetchHuggingfaceCommit('org/missing', { fetchImpl })).rejects.toThrow(/404/);
  });

  it('throws when the response carries no valid sha', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sha: 'not-a-sha' }), { status: 200 })) as typeof fetch;
    await expect(fetchHuggingfaceCommit('org/repo', { fetchImpl })).rejects.toThrow(/no valid sha/);
  });
});
