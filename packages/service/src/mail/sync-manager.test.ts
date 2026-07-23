import { securityPolicyForLevel } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import type { SystemIdleState } from '../system/idle-state.js';
import type { MailManager } from './manager.js';
import { MailSyncManager } from './sync-manager.js';

function mailProject(id: string, lastSyncedAt?: string) {
  return {
    id,
    name: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mail: {
      accounts: [
        {
          id: 'imap:a@x.com',
          provider: 'imap' as const,
          address: 'a@x.com',
          ...(lastSyncedAt ? { lastSyncedAt } : {}),
        },
      ],
    },
  };
}

interface Harness {
  manager: MailSyncManager;
  syncProject: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  projects: ReturnType<typeof mailProject>[];
  level?: 'free' | 'lockdown';
  chatActive?: boolean;
  projectActive?: boolean;
}): Harness {
  const syncProject = vi.fn(async () => [
    { accountId: 'imap:a@x.com', written: 1, quarantined: 0, skipped: 0, errors: 0 },
  ]);
  const store = {
    readConfig: async () => ({ securityPolicy: securityPolicyForLevel(opts.level ?? 'free') }),
    listProjects: async () => opts.projects,
    getProject: async (id: string) => opts.projects.find((p) => p.id === id) ?? null,
  } as unknown as Store;
  const chat = {
    isAnyActive: () => opts.chatActive ?? false,
    isProjectActive: () => opts.projectActive ?? false,
  } as unknown as ChatManager;
  const idle = { osIdleSeconds: () => 600 } as unknown as SystemIdleState;
  const mail = { syncProject } as unknown as MailManager;
  return {
    manager: new MailSyncManager({ store, chat, idle, mail }),
    syncProject,
  };
}

describe('MailSyncManager.tick', () => {
  it('syncs a due mail-enabled project', async () => {
    const h = harness({ projects: [mailProject('p1')] });
    await h.manager.tick();
    expect(h.syncProject).toHaveBeenCalledTimes(1);
  });

  it('does not sync when the security posture forbids mail', async () => {
    const h = harness({ projects: [mailProject('p1')], level: 'lockdown' });
    await h.manager.tick();
    expect(h.syncProject).not.toHaveBeenCalled();
  });

  it('does not sync while a chat turn is in flight', async () => {
    const h = harness({ projects: [mailProject('p1')], chatActive: true });
    await h.manager.tick();
    expect(h.syncProject).not.toHaveBeenCalled();
  });

  it('skips projects with an active chat session', async () => {
    const h = harness({ projects: [mailProject('p1')], projectActive: true });
    await h.manager.tick();
    expect(h.syncProject).not.toHaveBeenCalled();
  });

  it('skips a project synced too recently', async () => {
    const fresh = new Date().toISOString();
    const h = harness({ projects: [mailProject('p1', fresh)] });
    await h.manager.tick();
    expect(h.syncProject).not.toHaveBeenCalled();
  });

  it('syncs a project whose last sync is stale', async () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const h = harness({ projects: [mailProject('p1', stale)] });
    await h.manager.tick();
    expect(h.syncProject).toHaveBeenCalledTimes(1);
  });
});
