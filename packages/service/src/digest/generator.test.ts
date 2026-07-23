import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { type DigestOneShot, ProjectDigestGenerator, isoWeek } from './generator.js';

let home: string;
let store: Store;
let history: HistoryManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-digest-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function makeGenerator(oneShot: ReturnType<typeof vi.fn>): ProjectDigestGenerator {
  return new ProjectDigestGenerator({ store, history, oneShot: oneShot as DigestOneShot });
}

async function seedProject(): Promise<string> {
  const project = await store.createProject({ name: 'Vogelhuis' });
  await history.log({
    kind: 'project.updated',
    projectId: project.id,
    summary: 'Tweaked the mission',
  });
  await history.log({
    kind: 'document.created',
    projectId: project.id,
    summary: 'Created document plans.md',
  });
  await history.log({
    kind: 'task.created',
    projectId: project.id,
    summary: 'Created task build the roof',
  });
  return project.id;
}

describe('isoWeek', () => {
  it('labels ISO weeks correctly across a year boundary', () => {
    expect(isoWeek(new Date('2026-07-04T12:00:00Z'))).toBe('2026-W27');
    expect(isoWeek(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
  });
});

describe('ProjectDigestGenerator', () => {
  it('writes a reports/ artifact + history event for an active week, idempotently', async () => {
    const projectId = await seedProject();
    const oneShot = vi.fn(
      async (_prompt: string, _timeoutMs: number, _opts: { useKlerk: boolean }) =>
        'The crew tweaked the mission and planned the roof.',
    );
    const gen = makeGenerator(oneShot);

    const first = await gen.sweep();
    expect(first.generated).toBe(1);
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot.mock.calls[0]?.[2]).toMatchObject({ useKlerk: true });

    const week = isoWeek(new Date());
    const artifact = await store.readProjectArtifact(projectId, `reports/digest-${week}.md`);
    expect(artifact).toContain('Vogelhuis');
    expect(artifact).toContain('The crew tweaked the mission');

    const events = await history.listEvents({ kinds: ['project.digest.generated'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.projectId).toBe(projectId);

    // Unchanged window → no second LLM call, no second artifact write.
    const second = await gen.sweep();
    expect(second.generated).toBe(0);
    expect(oneShot).toHaveBeenCalledTimes(1);
  });

  it('regenerates when new activity lands in the same week', async () => {
    const projectId = await seedProject();
    const oneShot = vi.fn(async () => 'Narrative.');
    const gen = makeGenerator(oneShot);
    await gen.sweep();
    await history.log({
      kind: 'task.created',
      projectId,
      summary: 'Created task paint the walls',
    });
    const again = await gen.sweep();
    expect(again.generated).toBe(1);
    expect(oneShot).toHaveBeenCalledTimes(2);
  });

  it('skips quiet projects entirely', async () => {
    await store.createProject({ name: 'Stil' });
    const oneShot = vi.fn(async () => 'Should not run.');
    const gen = makeGenerator(oneShot);
    const r = await gen.sweep();
    expect(r.generated).toBe(0);
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('respects config.digest.enabled=false and the pause switch', async () => {
    await seedProject();
    const oneShot = vi.fn(async () => 'x');

    await store.writeConfig({ digest: { enabled: false } });
    expect((await makeGenerator(oneShot).sweep()).generated).toBe(0);
    await store.writeConfig({ digest: { enabled: true } });

    const paused = new ProjectDigestGenerator({
      store,
      history,
      oneShot: oneShot as DigestOneShot,
      isPaused: () => true,
    });
    expect((await paused.sweep()).generated).toBe(0);
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('defers optional model work while foreground chat is active', async () => {
    await seedProject();
    const oneShot = vi.fn(async () => 'Should not run over live chat.');
    let active = true;
    const gen = new ProjectDigestGenerator({
      store,
      history,
      oneShot: oneShot as DigestOneShot,
      isChatActive: () => active,
    });

    expect((await gen.sweep()).generated).toBe(0);
    expect(oneShot).not.toHaveBeenCalled();

    active = false;
    expect((await gen.sweep()).generated).toBe(1);
    expect(oneShot).toHaveBeenCalledTimes(1);
  });
});
