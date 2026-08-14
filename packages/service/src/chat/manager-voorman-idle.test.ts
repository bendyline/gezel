import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let mock: MockProvider;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-vm-idle-'));
  store = new Store({ home });
  await store.ensureLayout();
  // Use openai-named mock so the voorman-idle check runs (it skips for
  // copilot, where the SDK runs tools inside its subprocess).
  mock = new MockProvider({ name: 'openai' });
  await store.writeConfig({ provider: 'openai' });
  await store.createGezel({ name: 'Leo', role: 'voorman' });
  await store.createProject({ name: 'Shop' });
  await store.updateProject('shop', { voormanGezelId: 'leo' });
  events = new ChatEventBus();
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['openai', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager — voorman-idle stall detection', () => {
  // `mock.calls` also captures the background memory-extraction send that
  // fires after every completed turn, so we can't compare raw counts.
  // Instead, filter to the VOORMAN_IDLE_NUDGE prompt shape directly.
  const nudgeSends = (calls: Array<{ kind: string; prompt?: string }>) =>
    calls.filter(
      (c) =>
        c.kind === 'send' &&
        /(?:make one quick project check|one project-state check)/i.test(c.prompt ?? ''),
    );

  const now = new Date('2026-06-06T00:00:00Z').toISOString();
  const seedTask = (status: 'active' | 'complete' | 'canceled' | 'paused') =>
    store.writeTask({
      projectId: 'shop',
      num: 1,
      ref: 'shop/1',
      title: 'Build it',
      status,
      assignee: { kind: 'gezel', gezelId: 'leo' },
      craftbook: {
        id: 'cb-1',
        name: 'cb',
        steps: [{ id: 'p1', name: 'do it', createdAt: now }],
        entryStepId: 'p1',
        createdAt: now,
        updatedAt: now,
      },
      activeStepId: 'p1',
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });

  it('does not turn a greeting in a fresh taskless project into proactive work', async () => {
    const session = await manager.createSession({ gezelId: 'leo', projectId: 'shop' });
    mock.script('Hello! Tell me what you would like to build, and I can help organize it.');

    await manager.send(session.id, 'hello!');

    expect(nudgeSends(mock.calls)).toHaveLength(0);
    const disk = await store.getSession('leo', session.id);
    const assistantMsgs = disk!.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
  });

  it('does not fire when the responder is not the project voorman', async () => {
    await store.createGezel({ name: 'Maya', role: 'Designer' });
    const session = await manager.createSession({ gezelId: 'maya', projectId: 'shop' });
    mock.script('Happy to report the mocks are looking good.');

    await manager.send(session.id, 'status?');

    expect(nudgeSends(mock.calls)).toHaveLength(0);
  });

  it('does not fire when the project has no voorman assigned', async () => {
    await store.updateProject('shop', { voormanGezelId: '' });
    const session = await manager.createSession({ gezelId: 'leo', projectId: 'shop' });
    mock.script('Happy to report the mocks are looking good.');

    await manager.send(session.id, 'status?');

    expect(nudgeSends(mock.calls)).toHaveLength(0);
  });

  it('does NOT fire when every task is terminal — a prose "it\'s done" is the right terminal', async () => {
    // The "Space Shooter Arcade" spin: project closed-and-verified, yet
    // each check-in re-nagged the voorman to "pick a tool", and the weak
    // model relitigated the menu for ~12 KB. With no `active` task there
    // is nothing to advance, so the idle nudge must stay silent.
    await seedTask('complete');
    const session = await manager.createSession({ gezelId: 'leo', projectId: 'shop' });
    mock.script('From my perspective the project is done and in a stable state.');

    await manager.send(session.id, 'status?');

    expect(nudgeSends(mock.calls)).toHaveLength(0);
  });

  it('fires at most one reminder when a task is active (real work is left to advance)', async () => {
    await seedTask('active');
    const session = await manager.createSession({ gezelId: 'leo', projectId: 'shop' });
    mock.script(
      'All set. The project is on track and the plan is progressing.',
      'Advancing the phase now.',
    );

    await manager.send(session.id, 'status?');

    expect(nudgeSends(mock.calls)).toHaveLength(1);
    const disk = await store.getSession('leo', session.id);
    expect(disk!.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('withholds the done/stable escape hatch when nothing has been built', async () => {
    // Wild-caught ("Space War Arcade"): gemma4-e4b replied
    // "My project is in a stable state" to every check-in over a
    // bootstrap-only workspace. With an active task and nothing built,
    // the nudge must direct a handoff — NOT hand the weak model the
    // "say it's done and stop" phrase it was parroting.
    await seedTask('active');
    // A dependency lockfile from `npm install @bendyline/gezel-cli` is
    // setup metadata, not evidence that the user built a deliverable.
    await store.writeProjectWorkspaceFile('shop', 'package-lock.json', '{"lockfileVersion":3}');
    const session = await manager.createSession({ gezelId: 'leo', projectId: 'shop' });
    mock.script('My project is in a stable state.', 'Messaging the builder now.');

    await manager.send(session.id, 'status?');

    const nudges = nudgeSends(mock.calls);
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    const prompt = nudges[0]?.prompt ?? '';
    expect(prompt).toContain('no deliverable has been built');
    // The permissive escape hatch and its canned, easily-parroted example
    // sentence must both be absent.
    expect(prompt).not.toContain('waiting on the user');
    expect(prompt).not.toContain('From my perspective');
  });

  it('keeps the done/stable escape hatch once real files exist', async () => {
    // Once the workspace holds a real deliverable, "done / stable" is
    // plausible — keep the escape hatch so a genuinely-finished voorman
    // isn't nagged into a "tool or no tool?" spiral.
    await seedTask('active');
    await store.writeProjectWorkspaceFile('shop', 'index.html', '<!doctype html><title>x</title>');
    const session = await manager.createSession({ gezelId: 'leo', projectId: 'shop' });
    mock.script(
      'All set. The project is on track and the plan is progressing.',
      'Advancing the phase now.',
    );

    await manager.send(session.id, 'status?');

    const nudges = nudgeSends(mock.calls);
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    expect(nudges[0]?.prompt ?? '').toContain('waiting on the user');
    expect(nudges[0]?.prompt ?? '').toContain('Do not invent work');
    expect(nudges[0]?.prompt ?? '').not.toContain('From my perspective');
  });
});
