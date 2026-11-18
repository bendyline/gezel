import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { withFrontmatter } from '../index-store/frontmatter.js';
import { ConnectorActionManager } from './actions.js';
import { registerConsentEnforcer } from './consent.js';
import { registerNativeAdapter } from './registry.js';
import type { ConnectorAdapter } from './types.js';

// Deny-by-default means even test actions need a registered scope.
registerConsentEnforcer('test-approve', () => ({ ok: true }));

let lastAction: { action: string; input: unknown } | null = null;
let failNextSend = false;
let sends = 0;

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
      sends++;
      if (failNextSend) {
        failNextSend = false;
        throw new Error('connection reset after the request was sent');
      }
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
    { name: 'publish', consentScope: 'social-publish' },
    {
      name: 'label',
      consentScope: 'test-approve',
      inputSchema: {
        type: 'object',
        required: ['label'],
        properties: { label: { type: 'string' }, color: { enum: ['red', 'green'] } },
      },
    },
  ],
  availableVersions: ['1.0.0'],
};

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-actions-'));
  lastAction = null;
  failNextSend = false;
  sends = 0;
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
    projectArtifactsDir: () => join(ws, 'artifacts'),
    projectQuarantineDir: () => join(ws, 'private', 'quarantine'),
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

describe('ConnectorActionManager send journal', () => {
  it('a commit that fails mid-send is held as uncertain and never sent again on its own', async () => {
    const m = mgr();
    const { draftId } = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'comment',
      input: { body: 'hi', failSend: true },
    });
    failNextSend = true;
    await expect(m.commit(project, draftId)).rejects.toThrow(/connection reset/);
    const { pending } = await m.list(project);
    expect(pending).toEqual([
      expect.objectContaining({
        draftId,
        status: 'uncertain',
        error: expect.stringMatching(/reset/),
      }),
    ]);
    await expect(m.commit(project, draftId)).rejects.toThrow(/may already have been sent/);
    expect(sends).toBe(1);
    // The person checks the account and discards it.
    await m.discard(project, draftId);
    expect((await m.list(project)).pending).toEqual([]);
  });
});

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

  it('refuses a draft its action input schema does not admit, naming the problem', async () => {
    const m = mgr();
    await expect(
      m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'label',
        input: { color: 'blue' },
      }),
    ).rejects.toThrow(/invalid input for fake-action-conn action 'label'.*label.*color/s);
    const { draftId } = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'label',
      input: { label: 'bug', color: 'red' },
    });
    expect((await m.list(project)).pending.map((p) => p.draftId)).toEqual([draftId]);
  });

  it('re-checks the input at commit, after the queued copy was edited', async () => {
    const m = mgr();
    const { draftId } = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'label',
      input: { label: 'bug' },
    });
    const { relPath } = await m.queue(project, draftId);
    const path = join(ws, 'artifacts', relPath);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('"label": "bug"', '"label": 7'));
    await expect(m.commit(project, draftId)).rejects.toThrow(
      /invalid input.*label: expected string/,
    );
    expect(lastAction).toBeNull();
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
      // The adapter gets the address the enforcer checked, not the raw entry.
      expect(lastAction?.input).toMatchObject({ to: ['friend@ok.example'] });
    } finally {
      project.connectors[0].config = {};
    }
  });

  it('recipient-allowlist: checks the address the transport delivers to', async () => {
    const m = mgr();
    project.connectors[0].config = { allowedRecipients: ['ok@trusted.com'] };
    try {
      for (const to of [
        ['"<ok@trusted.com>" <attacker@evil.com>'],
        ['<ok@trusted.com>, attacker@evil.com'],
        ['friends: ok@trusted.com, attacker@evil.com;'],
        'ok@trusted.com, attacker@evil.com',
        [{ address: 'attacker@evil.com' }, 'ok@trusted.com'],
      ]) {
        const { draftId } = await m.draft(project, {
          bindingId: 'fake-action-conn:abc',
          action: 'send',
          input: { to, body: 'hi' },
        });
        await expect(m.commit(project, draftId)).rejects.toThrow(/commit denied/);
      }
      const cc = await m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'send',
        input: { to: ['ok@trusted.com'], bcc: ['"ok@trusted.com" attacker@evil.com'], body: 'hi' },
      });
      await expect(m.commit(project, cc.draftId)).rejects.toThrow(/commit denied/);
      expect(lastAction).toBeNull();
    } finally {
      project.connectors[0].config = {};
    }
  });

  it('recipient-allowlist: frontmatter recipients cannot vouch for the input', async () => {
    // The draft file sits in the gezel-writable `_actions/` tree. Only the
    // input reaches the adapter, so it must be checked even when the
    // frontmatter names allowlisted addresses.
    const m = mgr();
    project.connectors[0].config = { allowedRecipients: ['ok@trusted.com'] };
    try {
      const { draftId, relPath } = await m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'send',
        input: {},
      });
      await writeFile(
        join(ws, 'artifacts', relPath),
        withFrontmatter(
          {
            binding: 'fake-action-conn:abc',
            action: 'send',
            draft_id: draftId,
            to: 'ok@trusted.com',
          },
          JSON.stringify({ to: ['attacker@evil.com'], body: 'hi' }),
        ),
      );
      await expect(m.commit(project, draftId)).rejects.toThrow(
        /not on the binding's allowlist: attacker@evil\.com/,
      );
      expect(lastAction).toBeNull();
    } finally {
      project.connectors[0].config = {};
    }
  });

  it('social-publish: denies unless the binding enables publishing, and never an empty draft', async () => {
    const m = mgr();
    const denied = await m.draft(project, {
      bindingId: 'fake-action-conn:abc',
      action: 'publish',
      input: { text: 'Hello Bluesky' },
    });
    await expect(m.commit(project, denied.draftId)).rejects.toThrow(
      /publishing is disabled on this connector/,
    );
    expect(lastAction).toBeNull();

    project.connectors[0].config = { allowPublish: true };
    try {
      const emptyText = await m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'publish',
        input: { text: '   ' },
      });
      await expect(m.commit(project, emptyText.draftId)).rejects.toThrow(/no post text/);
      expect(lastAction).toBeNull();

      const allowed = await m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'publish',
        input: { text: 'Hello Bluesky' },
      });
      const r = await m.commit(project, allowed.draftId);
      expect(r.status).toBe('committed');
      expect(lastAction).toEqual({ action: 'publish', input: { text: 'Hello Bluesky' } });
    } finally {
      project.connectors[0].config = {};
    }
  });

  it('social-publish: rejects malformed images shapes before the adapter runs', async () => {
    const m = mgr();
    project.connectors[0].config = { allowPublish: true };
    try {
      const nonArray = await m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'publish',
        input: { text: 'pics', images: 'shot.png' },
      });
      await expect(m.commit(project, nonArray.draftId)).rejects.toThrow(/images must be an array/);

      const tooMany = await m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'publish',
        input: {
          text: 'pics',
          images: Array.from({ length: 5 }, (_, i) => ({ path: `p${i}.png` })),
        },
      });
      await expect(m.commit(project, tooMany.draftId)).rejects.toThrow(
        /attaches 5 images; the maximum is 4/,
      );

      const noPath = await m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'publish',
        input: { text: 'pics', images: [{ alt: 'no path' }] },
      });
      await expect(m.commit(project, noPath.draftId)).rejects.toThrow(
        /images\[0\] has no string path/,
      );
      expect(lastAction).toBeNull();

      const wellFormed = await m.draft(project, {
        bindingId: 'fake-action-conn:abc',
        action: 'publish',
        input: { text: 'pics', images: [{ path: 'shots/launch.png', alt: 'Launch chart' }] },
      });
      const r = await m.commit(project, wellFormed.draftId);
      expect(r.status).toBe('committed');
      expect(lastAction).toEqual({
        action: 'publish',
        input: { text: 'pics', images: [{ path: 'shots/launch.png', alt: 'Launch chart' }] },
      });
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
