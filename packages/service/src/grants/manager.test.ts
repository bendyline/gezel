import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTokenStore } from '../http/token-store.js';
import { type GrantEvent, createGrantManager, parseAutoApproveAppIds } from './manager.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-grant-mgr-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('parseAutoApproveAppIds', () => {
  it('parses a comma-separated list with whitespace and empty entries dropped', () => {
    expect(parseAutoApproveAppIds(' a, b ,, c, ')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for undefined or empty', () => {
    expect(parseAutoApproveAppIds(undefined)).toEqual([]);
    expect(parseAutoApproveAppIds('')).toEqual([]);
    expect(parseAutoApproveAppIds(' , , ')).toEqual([]);
  });
});

describe('GrantManager — request / approve / deny lifecycle', () => {
  it('request creates a pending grant and persists it', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    const events: GrantEvent[] = [];
    grants.subscribe((e) => events.push(e));

    const grant = await grants.request({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });

    expect(grant.status).toBe('pending');
    expect(grant.token).toBeUndefined();
    expect(grants.get(grant.id)?.appId).toBe('docblocks');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('grant_requested');

    const raw = await readFile(join(home, 'pending-grants.json'), 'utf8');
    const parsed = JSON.parse(raw) as { grants: Array<{ id: string }> };
    expect(parsed.grants.map((g) => g.id)).toContain(grant.id);
  });

  it('rejects reserved scopes before creating or auto-approving a grant', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({
      home,
      tokenStore,
      autoApproveAppIds: ['internal-spoof'],
    });
    await expect(
      grants.request({ appId: 'internal-spoof', appName: 'Spoof', scopes: ['ui'] }),
    ).rejects.toThrow(/invalid app scopes/);
    expect(grants.list()).toEqual([]);
    expect(tokenStore.list().map((record) => record.appId)).toEqual(['root']);
  });

  it('approve issues a per-app token, persists, and emits grant_decided', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    const decided: GrantEvent[] = [];
    grants.subscribe((e) => {
      if (e.type === 'grant_decided') decided.push(e);
    });

    const grant = await grants.request({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    expect(tokenStore.list().map((t) => t.appId)).not.toContain('docblocks');

    const approved = await grants.approve(grant.id);
    expect(approved.status).toBe('approved');
    expect(approved.token).toBeTruthy();
    expect(approved.decidedAt).toBeGreaterThan(0);
    expect(tokenStore.lookup(approved.token!)?.appId).toBe('docblocks');
    expect(decided).toHaveLength(1);
  });

  it('delivers an approved token once and removes it from grant storage', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    const grant = await grants.request({
      appId: 'one-time',
      appName: 'One Time',
      scopes: ['openai'],
    });
    const approved = await grants.approve(grant.id);
    const issuedToken = approved.token;

    expect(await grants.consumeToken(grant.id)).toBe(issuedToken);
    expect(await grants.consumeToken(grant.id)).toBeNull();
    expect(grants.get(grant.id)?.token).toBeUndefined();

    const persisted = await readFile(join(home, 'pending-grants.json'), 'utf8');
    expect(persisted).not.toContain(issuedToken!);
  });

  it('deduplicates pending requests for the same app id', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    await grants.request({ appId: 'duplicate', appName: 'First', scopes: ['openai'] });
    await expect(
      grants.request({ appId: 'duplicate', appName: 'Second', scopes: ['openai'] }),
    ).rejects.toThrow(/pending grant already exists/);
  });

  it('expires a stale pending request during sweeping', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    const grant = await grants.request({ appId: 'stale', appName: 'Stale', scopes: ['openai'] });
    grant.expiresAt = Date.now() - 1;

    await grants.sweepExpired();
    expect(grants.get(grant.id)).toMatchObject({ status: 'expired' });
  });

  it('revokes an approved token that expires before delivery', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    const grant = await grants.request({
      appId: 'unclaimed',
      appName: 'Unclaimed',
      scopes: ['openai'],
    });
    const approved = await grants.approve(grant.id);
    const token = approved.token!;
    approved.expiresAt = Date.now() - 1;

    await grants.sweepExpired();

    expect(grants.get(grant.id)).toMatchObject({ status: 'expired' });
    expect(tokenStore.lookup(token)).toBeNull();
  });

  it('revalidates a pending grant immediately before issuance', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    const grant = await grants.request({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    grant.scopes = ['root'];
    await expect(grants.approve(grant.id)).rejects.toThrow(/invalid app scopes/);
    expect(tokenStore.list().map((record) => record.appId)).toEqual(['root']);
  });

  it('deny transitions to denied without issuing a token', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    const grant = await grants.request({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });

    const denied = await grants.deny(grant.id);
    expect(denied.status).toBe('denied');
    expect(denied.token).toBeUndefined();
    expect(tokenStore.list().map((t) => t.appId)).not.toContain('docblocks');
  });

  it('approve and deny throw when the grant is already decided', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    const grant = await grants.request({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    await grants.approve(grant.id);
    await expect(grants.approve(grant.id)).rejects.toThrow(/already decided/);
    await expect(grants.deny(grant.id)).rejects.toThrow(/already decided/);
  });

  it('throws when approving or denying a non-existent grant', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    await expect(grants.approve('nope')).rejects.toThrow(/not found/);
    await expect(grants.deny('nope')).rejects.toThrow(/not found/);
  });

  it('persists decided grants across reload', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const first = await createGrantManager({ home, tokenStore });
    const grant = await first.request({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    await first.approve(grant.id);

    // Reopen — both the token (via tokens.json) and the grant record
    // come back.
    const tokenStore2 = await createTokenStore({ home, rootToken: 'ROOT-2' });
    const second = await createGrantManager({ home, tokenStore: tokenStore2 });
    const reloaded = second.get(grant.id);
    expect(reloaded?.status).toBe('approved');
    expect(reloaded?.token).toBeTruthy();
    expect(tokenStore2.lookup(reloaded!.token!)?.appId).toBe('docblocks');
  });

  it('recovers an approval interrupted after the token became durable', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const issued = await tokenStore.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
      token: 'DURABLE-TOKEN',
    });
    await writeFile(
      join(home, 'pending-grants.json'),
      JSON.stringify({
        version: 1,
        grants: [
          {
            id: 'interrupted-grant',
            appId: 'docblocks',
            appName: 'DocBlocks',
            scopes: ['openai'],
            status: 'pending',
            createdAt: Date.now(),
            issuingToken: issued.token,
          },
        ],
      }),
      'utf8',
    );

    const grants = await createGrantManager({ home, tokenStore });
    expect(grants.get('interrupted-grant')).toMatchObject({
      status: 'approved',
      token: issued.token,
    });
    expect(grants.get('interrupted-grant')?.issuingToken).toBeUndefined();

    const persisted = JSON.parse(await readFile(join(home, 'pending-grants.json'), 'utf8')) as {
      grants: Array<{ status: string; token?: string; issuingToken?: string }>;
    };
    expect(persisted.grants[0]).toMatchObject({ status: 'approved', token: issued.token });
    expect(persisted.grants[0]?.issuingToken).toBeUndefined();
  });

  it('never exposes a different pre-existing app token while recovering a grant', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const existing = await tokenStore.issue({
      appId: 'docblocks',
      appName: 'Existing DocBlocks',
      scopes: ['openai'],
      token: 'EXISTING-APP-TOKEN',
    });
    await writeFile(
      join(home, 'pending-grants.json'),
      JSON.stringify({
        version: 1,
        grants: [
          {
            id: 'not-yet-issued',
            appId: 'docblocks',
            appName: 'DocBlocks',
            scopes: ['openai'],
            status: 'pending',
            createdAt: Date.now(),
            issuingToken: 'TOKEN-THAT-WAS-NEVER-ISSUED',
          },
        ],
      }),
      'utf8',
    );
    const grants = await createGrantManager({ home, tokenStore });
    expect(grants.get('not-yet-issued')).toMatchObject({ status: 'pending' });
    expect(grants.get('not-yet-issued')?.token).toBeUndefined();
    expect(grants.get('not-yet-issued')?.issuingToken).toBeUndefined();
    expect(tokenStore.lookup(existing.token)?.appName).toBe('Existing DocBlocks');
  });

  it('GEZEL_AUTOAPPROVE_APPS path mints a token at request time', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({
      home,
      tokenStore,
      autoApproveAppIds: ['docblocks'],
    });

    const grant = await grants.request({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });

    expect(grant.status).toBe('approved');
    expect(grant.token).toBeTruthy();
    expect(tokenStore.lookup(grant.token!)?.appId).toBe('docblocks');
  });

  it('autoapprove for an already-connected appId degrades to denied (safety net)', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    await tokenStore.issue({
      appId: 'docblocks',
      appName: 'Pre-existing DocBlocks',
      scopes: ['openai'],
    });
    const grants = await createGrantManager({
      home,
      tokenStore,
      autoApproveAppIds: ['docblocks'],
    });

    const grant = await grants.request({
      appId: 'docblocks',
      appName: 'DocBlocks (retry)',
      scopes: ['openai'],
    });
    // We didn't reissue an existing token; the request is flagged denied
    // so the caller sees a clear non-success path. In production, the
    // route layer rejects with 409 before reaching this fallback.
    expect(grant.status).toBe('denied');
    expect(grant.token).toBeUndefined();
  });

  it('subscribe returns an unsubscribe that detaches the listener', async () => {
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    const grants = await createGrantManager({ home, tokenStore });
    const seen: GrantEvent[] = [];
    const unsubscribe = grants.subscribe((e) => seen.push(e));

    await grants.request({ appId: 'a', appName: 'A', scopes: ['openai'] });
    expect(seen).toHaveLength(1);

    unsubscribe();
    await grants.request({ appId: 'b', appName: 'B', scopes: ['openai'] });
    expect(seen).toHaveLength(1); // unchanged
  });

  it('fails loudly on a malformed pending-grants.json without a backup', async () => {
    await writeFile(join(home, 'pending-grants.json'), '{not json', 'utf8');
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    await expect(createGrantManager({ home, tokenStore })).rejects.toThrow(/unusable/);
  });

  it('rejects persisted grants carrying internal scopes or unknown kinds', async () => {
    const now = Date.now();
    await writeFile(
      join(home, 'pending-grants.json'),
      JSON.stringify({
        version: 1,
        grants: [
          {
            id: 'valid',
            appId: 'valid-app',
            appName: 'Valid',
            scopes: ['openai'],
            status: 'pending',
            createdAt: now,
          },
          {
            id: 'root-scope',
            appId: 'planted-root',
            appName: 'Root',
            scopes: ['root'],
            status: 'pending',
            createdAt: now,
          },
          {
            id: 'ui-scope',
            appId: 'planted-ui',
            appName: 'UI',
            scopes: ['ui'],
            status: 'pending',
            createdAt: now,
          },
          {
            id: 'session-id',
            appId: 'session:planted',
            appName: 'Session',
            scopes: ['openai'],
            status: 'pending',
            createdAt: now,
          },
          {
            id: 'bad-kind',
            appId: 'bad-kind',
            appName: 'Bad kind',
            scopes: ['openai'],
            status: 'pending',
            createdAt: now,
            kind: 'root',
          },
        ],
      }),
      'utf8',
    );
    const tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
    await expect(createGrantManager({ home, tokenStore })).rejects.toThrow(/unusable/);
  });
});
