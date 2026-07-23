import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTokenStore } from './token-store.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-token-store-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('TokenStore', () => {
  it('pre-registers the root token in-memory with scopes=[root]', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT-LITERAL' });
    const rec = store.lookup('ROOT-LITERAL');
    expect(rec).not.toBeNull();
    expect(rec?.appId).toBe('root');
    expect(rec?.scopes).toEqual(['root']);
  });

  it('returns null for an unknown token', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    expect(store.lookup('bogus')).toBeNull();
  });

  it('issues a per-app token and round-trips lookup by token + list by appId', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    const rec = await store.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    expect(rec.token).toBeTruthy();
    expect(rec.scopes).toEqual(['openai']);
    expect(store.lookup(rec.token)?.appId).toBe('docblocks');
    const ids = store.list().map((r) => r.appId);
    expect(ids).toContain('docblocks');
    expect(ids).toContain('root');
  });

  it('persists per-app tokens to disk and reloads them on the next open', async () => {
    const first = await createTokenStore({ home, rootToken: 'ROOT-1' });
    const issued = await first.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });

    // The on-disk file exists and contains the docblocks token but NOT the
    // root token (root is in-memory only — rotates every launch).
    const tokensPath = join(home, 'tokens.json');
    const raw = await readFile(tokensPath, 'utf8');
    const parsed = JSON.parse(raw) as { version: number; tokens: Array<{ appId: string }> };
    expect(parsed.version).toBe(1);
    const persistedIds = parsed.tokens.map((t) => t.appId);
    expect(persistedIds).toContain('docblocks');
    expect(persistedIds).not.toContain('root');

    const second = await createTokenStore({ home, rootToken: 'ROOT-2' });
    // The newly-rotated root token is what authorizes now.
    expect(second.lookup('ROOT-2')?.appId).toBe('root');
    // The prior root token is no longer recognized.
    expect(second.lookup('ROOT-1')).toBeNull();
    // The docblocks token persists across reopen.
    expect(second.lookup(issued.token)?.appId).toBe('docblocks');
    expect(second.lookup(issued.token)?.scopes).toEqual(['openai']);
  });

  it('rejects a duplicate appId', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    await store.issue({ appId: 'docblocks', appName: 'DocBlocks', scopes: ['openai'] });
    await expect(
      store.issue({ appId: 'docblocks', appName: 'Other', scopes: ['openai'] }),
    ).rejects.toThrow(/already has a token/);
  });

  it("refuses to issue 'root' as an appId", async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    await expect(
      store.issue({ appId: 'root', appName: 'Spoof', scopes: ['root'] }),
    ).rejects.toThrow(/reserved/);
  });

  it('rejects internal, unknown, and empty scopes at the token mint boundary', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    for (const scopes of [[], ['root'], ['ui'], ['session'], ['workspace:read']]) {
      await expect(
        store.issue({ appId: `app-${scopes[0] ?? 'empty'}`, appName: 'Untrusted', scopes }),
      ).rejects.toThrow(/invalid app scopes/);
    }
  });

  it('rejects persisted internal scopes, reserved app ids, and unknown token kinds', async () => {
    const now = Date.now();
    await writeFile(
      join(home, 'tokens.json'),
      JSON.stringify({
        version: 1,
        tokens: [
          {
            appId: 'valid-app',
            appName: 'Valid',
            scopes: ['openai'],
            token: 'VALID-TOKEN',
            createdAt: now,
          },
          {
            appId: 'planted-root',
            appName: 'Root',
            scopes: ['root'],
            token: 'PLANTED-ROOT',
            createdAt: now,
          },
          {
            appId: 'planted-ui',
            appName: 'UI',
            scopes: ['ui'],
            token: 'PLANTED-UI',
            createdAt: now,
          },
          {
            appId: 'session:planted',
            appName: 'Session',
            scopes: ['openai'],
            token: 'PLANTED-SESSION',
            createdAt: now,
          },
          {
            appId: 'bad-kind',
            appName: 'Bad kind',
            scopes: ['openai'],
            token: 'BAD-KIND',
            createdAt: now,
            kind: 'root',
          },
        ],
      }),
      'utf8',
    );

    await expect(createTokenStore({ home, rootToken: 'ROOT' })).rejects.toThrow(/unusable/);
  });

  it('revoke drops the token and persists the removal', async () => {
    const first = await createTokenStore({ home, rootToken: 'ROOT-1' });
    const rec = await first.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    expect(first.lookup(rec.token)).not.toBeNull();

    const removed = await first.revoke('docblocks');
    expect(removed).toBe(true);
    expect(first.lookup(rec.token)).toBeNull();

    // Confirm the removal sticks across reopen.
    const second = await createTokenStore({ home, rootToken: 'ROOT-2' });
    expect(second.lookup(rec.token)).toBeNull();
    expect(second.list().map((r) => r.appId)).toEqual(['root']);
  });

  it('revoke returns false for an unknown appId and refuses to revoke root', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    expect(await store.revoke('nope')).toBe(false);
    expect(await store.revoke('root')).toBe(false);
    expect(store.lookup('ROOT')?.appId).toBe('root');
  });

  it('rolls an issued token back out of memory when its durable write fails', async () => {
    const tokensPath = join(home, 'tokens.json');
    const store = await createTokenStore({ home, rootToken: 'ROOT', filePath: tokensPath });
    await mkdir(tokensPath);
    await expect(
      store.issue({ appId: 'docblocks', appName: 'DocBlocks', scopes: ['openai'] }),
    ).rejects.toThrow();
    expect(store.list().map((record) => record.appId)).toEqual(['root']);
  });

  it('rolls a revocation back in memory when its durable write fails', async () => {
    const tokensPath = join(home, 'tokens.json');
    const store = await createTokenStore({ home, rootToken: 'ROOT', filePath: tokensPath });
    const issued = await store.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    await unlink(tokensPath);
    await mkdir(tokensPath);

    await expect(store.revoke('docblocks')).rejects.toThrow();
    expect(store.lookup(issued.token)?.appId).toBe('docblocks');
  });

  it('touch updates lastUsedAt without writing to disk', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    const rec = await store.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    expect(rec.lastUsedAt).toBe(0);
    store.touch(rec.token);
    const after = store.lookup(rec.token);
    expect(after?.lastUsedAt).toBeGreaterThan(0);

    // touch is in-memory only — the on-disk file still records lastUsedAt
    // as zero (we elided the field for the persisted record).
    const tokensPath = join(home, 'tokens.json');
    const raw = await readFile(tokensPath, 'utf8');
    const parsed = JSON.parse(raw) as { tokens: Array<{ lastUsedAt?: number }> };
    expect(parsed.tokens[0]?.lastUsedAt ?? 0).toBe(0);
  });

  it('fails loudly on a malformed tokens.json with no valid backup', async () => {
    await writeFile(join(home, 'tokens.json'), '{this is not json', 'utf8');
    await expect(createTokenStore({ home, rootToken: 'ROOT' })).rejects.toThrow(/unusable/);
  });

  it('recovers a corrupt primary file from its validated backup', async () => {
    const first = await createTokenStore({ home, rootToken: 'ROOT-1' });
    const issued = await first.issue({ appId: 'safe-app', appName: 'Safe', scopes: ['openai'] });
    await writeFile(join(home, 'tokens.json'), '{corrupt', 'utf8');
    const second = await createTokenStore({ home, rootToken: 'ROOT-2' });
    expect(second.lookup(issued.token)?.appId).toBe('safe-app');
  });
});

describe('TokenStore — session tokens (#10)', () => {
  it('requires the reserved session appId namespace', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    expect(() =>
      store.issueSession({
        appId: 'ordinary-app',
        projectId: 'proj-a',
        gezelId: 'gz-1',
        team: false,
      }),
    ).toThrow(/must start with 'session:'/);
  });

  it('issueSession carries the project/gezel/team scope and a session scope tag', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    const rec = store.issueSession({
      appId: 'session:s1',
      projectId: 'proj-a',
      gezelId: 'gz-1',
      team: false,
    });
    expect(rec.scopes).toEqual(['session']);
    expect(rec.projectId).toBe('proj-a');
    expect(rec.gezelId).toBe('gz-1');
    expect(rec.team).toBe(false);
    expect(store.lookup(rec.token)?.projectId).toBe('proj-a');
  });

  it('issueSession tokens are ephemeral — never written to tokens.json', async () => {
    const store = await createTokenStore({
      home,
      rootToken: 'ROOT',
      filePath: join(home, 'tokens.json'),
    });
    // Also issue a real (persisted) app token to force a flush to disk.
    await store.issue({ appId: 'docblocks', appName: 'DocBlocks', scopes: ['openai'] });
    const sess = store.issueSession({
      appId: 'session:s1',
      projectId: 'proj-a',
      gezelId: 'gz-1',
      team: true,
    });
    const raw = await readFile(join(home, 'tokens.json'), 'utf8');
    const parsed = JSON.parse(raw) as { tokens: Array<{ appId: string }> };
    const ids = parsed.tokens.map((t) => t.appId);
    expect(ids).toContain('docblocks');
    expect(ids).not.toContain('session:s1');
    // And a fresh store (reloading from disk) doesn't know the session token.
    const reloaded = await createTokenStore({
      home,
      rootToken: 'ROOT-2',
      filePath: join(home, 'tokens.json'),
    });
    expect(reloaded.lookup(sess.token)).toBeNull();
  });

  it('issueSession is get-or-create: re-issue keeps the live bridge token, refreshes scope in place', async () => {
    // Contract changed: issueSession used to ROTATE (delete the
    // prior token) on every re-issue. But the mint is a side effect of
    // buildSessionOpts, which re-runs post-spawn (recomputeSystemMessage)
    // while the bridge keeps the FIRST token in its env — rotation 401'd
    // every bridge tool call. Now re-issue returns the SAME token (stable
    // for the session's life) and only updates the scope binding; genuine
    // rotation is via revokeSession() on teardown.
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    const first = store.issueSession({
      appId: 'session:s1',
      projectId: 'proj-a',
      gezelId: 'gz-1',
      team: false,
    });
    const second = store.issueSession({
      appId: 'session:s1',
      projectId: 'proj-b', // scope shifted
      gezelId: 'gz-1',
      team: true,
    });
    // Same token — the bridge holding `first.token` stays authenticated.
    expect(second.token).toBe(first.token);
    expect(store.lookup(first.token)?.appId).toBe('session:s1');
    // Scope binding refreshed in place.
    expect(store.lookup(first.token)?.projectId).toBe('proj-b');
    expect(store.lookup(first.token)?.team).toBe(true);
  });

  it('issueSession after revokeSession mints a fresh token (real rotation path)', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    const first = store.issueSession({
      appId: 'session:s1',
      projectId: 'proj-a',
      gezelId: 'gz-1',
      team: false,
    });
    store.revokeSession('session:s1');
    expect(store.lookup(first.token)).toBeNull();
    const second = store.issueSession({
      appId: 'session:s1',
      projectId: 'proj-a',
      gezelId: 'gz-1',
      team: false,
    });
    expect(second.token).not.toBe(first.token);
    expect(store.lookup(second.token)?.appId).toBe('session:s1');
  });

  it('revokeSession removes the token', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    const rec = store.issueSession({
      appId: 'session:s1',
      projectId: 'proj-a',
      gezelId: 'gz-1',
      team: false,
    });
    store.revokeSession('session:s1');
    expect(store.lookup(rec.token)).toBeNull();
  });
});
