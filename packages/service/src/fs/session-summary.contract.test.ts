import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { portableStoreOverHome } from '../test-support/portable-node-files.js';
import { Store } from './store.js';

/**
 * The desktop store and the portable runtime summarize the same session
 * file. This holds the two hosts to one answer for one on-disk record.
 */
let home: string;
let store: Store;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-session-summary-contract-'));
  store = new Store({ home });
  await store.ensureLayout();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fixture(id: string, messages: ChatSession['messages']): ChatSession {
  const at = '2026-04-14T10:00:00Z';
  return {
    version: 1,
    id,
    gezelId: 'ada',
    projectId: 'default',
    providerName: 'copilot',
    model: 'mock-fast',
    title: 'Untitled',
    createdAt: at,
    lastActivityAt: at,
    messages,
    providerState: {},
  } as ChatSession;
}

describe('session summaries agree across hosts', () => {
  it('lists identical summaries for sessions the desktop store wrote', async () => {
    await store.writeSession(
      fixture('one', [
        { role: 'user', content: 'x', at: '2026-04-14T10:00:00Z' },
        {
          role: 'user',
          content: 'Can you review this?',
          at: '2026-04-14T10:01:00Z',
          from: { gezelId: 'reviewer', gezelName: 'Reviewer' },
        },
        { role: 'assistant', content: 'The latest\nreply is ready.', at: '2026-04-14T10:02:00Z' },
      ]),
    );
    await store.writeSession(fixture('two', []));

    const desktop = await store.listSessions({ gezelId: 'ada' });
    const portable = await portableStoreOverHome(home).listSessions({ gezelId: 'ada' });
    expect(desktop.length).toBe(2);
    expect(portable).toEqual(desktop);
  });
});
