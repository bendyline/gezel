import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTokenStore,
  isReservedPublicGrantAppId,
  isReservedTokenAppId,
} from './token-store.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-token-harness-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('harness tokens', () => {
  it('mint one ephemeral, project-bound token per app and project', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    const first = store.issueHarness({
      client: 'claude-code',
      projectId: 'repo',
      appName: 'Claude Code',
      folder: '/work/repo',
    });
    expect(first).toMatchObject({
      appId: 'harness:claude-code:repo',
      scopes: ['harness'],
      projectId: 'repo',
      kind: 'harness',
      folder: '/work/repo',
    });
    expect(store.lookup(first.token)?.appId).toBe('harness:claude-code:repo');

    const again = store.issueHarness({
      client: 'claude-code',
      projectId: 'repo',
      appName: 'Claude Code',
    });
    expect(again.token).toBe(first.token);

    const unbound = store.issueHarness({
      client: 'claude-desktop',
      projectId: null,
      appName: 'Claude Desktop',
    });
    expect(unbound.appId).toBe('harness:claude-desktop:none');
    expect(unbound.projectId).toBeUndefined();
  });

  it('never write a harness token to tokens.json', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    store.issueHarness({ client: 'codex', projectId: 'repo', appName: 'Codex' });
    await store.issue({ appId: 'docblocks', appName: 'DocBlocks', scopes: ['openai'] });
    const persisted = await readFile(join(home, 'tokens.json'), 'utf8');
    expect(persisted).toContain('docblocks');
    expect(persisted).not.toContain('harness');

    const reopened = await createTokenStore({ home, rootToken: 'ROOT2' });
    expect(reopened.list().some((r) => r.appId.startsWith('harness:'))).toBe(false);
  });

  it('revoke the tokens a predicate selects, and only harness tokens', async () => {
    const store = await createTokenStore({ home, rootToken: 'ROOT' });
    const a = store.issueHarness({ client: 'codex', projectId: 'a', appName: 'Codex' });
    const b = store.issueHarness({ client: 'codex', projectId: 'b', appName: 'Codex' });
    const c = store.issueHarness({ client: 'cursor', projectId: 'a', appName: 'Cursor' });
    expect(store.revokeHarness((r) => r.appId.startsWith('harness:codex:'))).toBe(2);
    expect(store.lookup(a.token)).toBeNull();
    expect(store.lookup(b.token)).toBeNull();
    expect(store.lookup(c.token)).not.toBeNull();
    expect(store.revokeHarness(() => true)).toBe(1);
    expect(store.lookup('ROOT')).not.toBeNull();
  });

  it('reserve the harness app-id prefix from the public consent flow', () => {
    expect(isReservedTokenAppId('harness:claude-code:repo')).toBe(true);
    expect(isReservedPublicGrantAppId('harness:x')).toBe(true);
  });
});
