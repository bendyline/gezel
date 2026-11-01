import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@bendyline/gezel';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Store } from '../../fs/store.js';
import type { ServiceContext } from '../context.js';
import { buildTimeline } from './timeline.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'timeline-visibility-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('reveals saved hidden prompts in debug mode without changing history or pagination', async () => {
  const project = await store.createProject({ name: 'Checkers' });
  const gezel = await store.createGezel({ name: 'Mira' });
  const messages: ChatSession['messages'] = [
    { role: 'user', content: 'Let’s play', at: '2026-04-14T11:00:00Z' },
    {
      role: 'user',
      content: '[Checkers page]: authoritative board state',
      at: '2026-04-14T11:00:01Z',
      origin: 'system',
      hidden: true,
    },
    { role: 'assistant', content: 'Your move!', at: '2026-04-14T11:00:02Z' },
  ];
  await store.writeSession({
    version: 1,
    id: 'checkers',
    gezelId: gezel.id,
    projectId: project.id,
    providerName: 'copilot',
    title: 'Checkers',
    createdAt: messages[0]!.at,
    lastActivityAt: messages[2]!.at,
    messages,
    providerState: {},
  });
  const ctx = { store, workspaceIndex: { readFiles: async () => [] } } as unknown as ServiceContext;
  const opts = { projectId: project.id, rawLimit: '2' };
  const normal = await buildTimeline(ctx, opts);
  expect(normal.messages.map((m) => m.content)).toEqual(['Let’s play', 'Your move!']);
  expect(normal.hasMore).toBe(false);
  await store.writeConfig({ debugMode: true });
  const debug = await buildTimeline(ctx, opts);
  expect(debug.messages[0]).toMatchObject({ hidden: true, origin: 'system' });
  expect(debug.hasMore).toBe(true);
  expect(debug.nextCursor).toBe(messages[1]!.at);
  const older = await buildTimeline(ctx, { ...opts, before: debug.nextCursor });
  expect(older.messages.map((m) => m.content)).toEqual(['Let’s play']);
  await store.writeConfig({ debugMode: false });
  expect((await buildTimeline(ctx, opts)).messages).toEqual(normal.messages);
  expect((await store.getSession(gezel.id, 'checkers'))?.messages).toEqual(messages);
});
