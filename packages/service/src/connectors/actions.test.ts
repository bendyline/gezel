import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { SecretStore } from '../secrets/types.js';
import { ConnectorActionManager } from './actions.js';
import { registerConsentEnforcer } from './consent.js';
import { registerNativeAdapter } from './registry.js';
import type { ConnectorAdapter } from './types.js';

// Deny-by-default means even test actions need a registered scope.
registerConsentEnforcer('test-approve', () => ({ ok: true }));

let lastAction: { action: string; input: unknown } | null = null;

registerNativeAdapter(
  'fake-action',
  async (): Promise<ConnectorAdapter> => ({
    typeId: 'fake-action',
    ensureAuth: async () => {},
    listScopes: async () => [''],
    listChangesSince: async () => ({ records: [], cursor: undefined }),
    fetchRecord: async () => {
      throw new Error('unused');
    },
    runAction: async (action, input) => {
      lastAction = { action, input };
      return { ok: true };
    },
    close: async () => {},
  }),
);

const MANIFEST = {
  schemaVersion: 1 as const,
  kind: 'connector-type' as const,
  id: 'fake-action-conn',
  name: 'Fake',
  description: '',
  tags: [],
  maintainer: { name: 'x' },
  version: '1.0.0',
  releasedAt: '2026-01-01T00:00:00Z',
  driver: 'native' as const,
  source: { adapterId: 'fake-action' },
  normalize: { kind: 'native' as const },
  actions: [
    { name: 'comment', consentScope: 'test-approve' },
    { name: 'escalate', consentScope: 'no-such-scope' },
    { name: 'send', consentScope: 'recipient-allowlist' },
  ],
  availableVersions: ['1.0.0'],
};

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-actions-'));
  lastAction = null;
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const project = {
  id: 'p1',
  connectors: [{ id: 'fake-action-conn:abc', type: 'fake-action-conn', config: {} }],
  // biome-ignore lint/suspicious/noExplicitAny: minimal ProjectDetail fake.
} as any;

function mgr(nightShift = false) {
  const store = {
    projectWorkspaceDir: async () => ws,
    getProject: async () => project,
  } as unknown as Store;
  const secrets = { get: async () => '{}' } as unknown as SecretStore;
  const catalog = { get: async () => ({ manifest: MANIFEST }) } as unknown as ConstructorParameters<
    typeof ConnectorActionManager
  >[0]['catalog'];
  return new ConnectorActionManager({
    store,
    secrets,
    catalog,
    isNightShiftActive: () => nightShift,
  });
}

describe('ConnectorActionManager', () => {
  it('drafts an action, lists it as pending, commits it via runAction', async () => {
    const m = mgr();
    const { draftId } = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'comment',
      input: { body: 'hi' },
    });
    const { pending } = await m.list(project);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.action).toBe('comment');
    expect(pending[0]?.status).toBe('draft');

    const r = await m.commit(project, draftId);
    expect(r.status).toBe('committed');
    expect(lastAction).toEqual({ action: 'comment', input: { body: 'hi' } });
    // draft is gone; a receipt is in _sent.
    const after = await m.list(project);
    expect(after.pending).toHaveLength(0);
  });

  it('defers the commit during night shift (stages to _outbox, no write)', async () => {
    const m = mgr(true);
    const { draftId } = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'comment',
      input: {},
    });
    const r = await m.commit(project, draftId);
    expect(r.status).toBe('queued-night-shift');
    expect(lastAction).toBeNull(); // NOT executed
    const { pending } = await m.list(project);
    expect(pending[0]?.status).toBe('queued'); // now staged in _outbox
  });

  it('discards a drafted action', async () => {
    const m = mgr();
    const { draftId } = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'comment',
    });
    await m.discard(project, draftId);
    expect((await m.list(project)).pending).toHaveLength(0);
  });

  it('rejects drafting an action the type does not declare', async () => {
    const m = mgr();
    await expect(
      m.draft(project, { bindingId: 'fake-action-conn:abc', action: 'delete-everything' }),
    ).rejects.toThrow(/declares no action 'delete-everything'.*available: comment, escalate, send/);
  });

  it('denies commit for a consent scope with no registered enforcer', async () => {
    const m = mgr();
    const { draftId } = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'escalate',
      input: {},
    });
    await expect(m.commit(project, draftId)).rejects.toThrow(
      /commit denied: no enforcer registered for consent scope 'no-such-scope'/,
    );
    expect(lastAction).toBeNull();
  });

  it('recipient-allowlist: denies unlisted recipients, allows listed ones', async () => {
    const m = mgr();
    const denied = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'send',
      input: { to: ['stranger@evil.example'], body: 'hi' },
    });
    await expect(m.commit(project, denied.draftId)).rejects.toThrow(
      /not on the binding's allowlist: stranger@evil\.example/,
    );
    expect(lastAction).toBeNull();

    project.connectors[0].config = { allowedRecipients: ['friend@ok.example'] };
    try {
      const allowed = await m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'send',
        input: { to: ['Friend <friend@ok.example>'], body: 'hi' },
      });
      const r = await m.commit(project, allowed.draftId);
      expect(r.status).toBe('committed');
      expect(lastAction?.action).toBe('send');
    } finally {
      project.connectors[0].config = {};
    }
  });

  it('queue() stages a draft to _outbox without executing anything', async () => {
    const m = mgr();
    const { draftId } = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'comment',
      input: {},
    });
    await m.queue(project, draftId);
    expect(lastAction).toBeNull();
    const { pending } = await m.list(project);
    expect(pending[0]?.status).toBe('queued');
  });
});
