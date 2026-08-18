import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEESTER_ABOUT_MD } from '../meester/prompt.js';
import { Store } from './store.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-meester-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Store.ensureDefaultMeester', () => {
  it('creates a fresh Meester when no gezels exist', async () => {
    expect((await store.listGezels()).length).toBe(0);
    await store.ensureDefaultMeester();

    const gezels = await store.listGezels();
    expect(gezels.length).toBe(1);
    const config = await store.readConfig();
    expect(config.meesterGezelId).toBe(gezels[0]!.id);

    // Sanity-check: role is 'Meester' and about.md carries the curated text.
    const detail = await store.getGezel(gezels[0]!.id);
    expect(detail?.role).toBe('Meester');
    expect(detail?.about).toMatch(/concierge|guildmaster|Meester/i);
  });

  it('is idempotent when the designated meester exists', async () => {
    await store.ensureDefaultMeester();
    const config1 = await store.readConfig();

    await store.ensureDefaultMeester();
    const config2 = await store.readConfig();

    expect(config2.meesterGezelId).toBe(config1.meesterGezelId);
    expect((await store.listGezels()).length).toBe(1);
  });

  it('auto-picks the first existing gezel when meesterGezelId is unset', async () => {
    const ada = await store.createGezel({ name: 'Ada', role: 'Developer' });
    const boz = await store.createGezel({ name: 'Boz', role: 'Writer' });
    const first = [ada, boz].sort((a, b) => a.name.localeCompare(b.name))[0]!;

    await store.ensureDefaultMeester();

    const config = await store.readConfig();
    expect(config.meesterGezelId).toBe(first.id);
    // Shouldn't have created a third gezel.
    expect((await store.listGezels()).length).toBe(2);
  });

  /**
   * The roster is sorted by name, so taking the first entry crowned whoever
   * sorted earliest regardless of what they do — wild-caught as a Klerk named
   * Ilse wearing the badge while a real Meester named Ulrike sat below her.
   * The badge is the lesser half: a Meester's abilities live in its curated
   * about.md, which a Klerk does not have.
   */
  it('prefers a gezel whose role is Meester over an earlier-sorting one', async () => {
    const ada = await store.createGezel({ name: 'Ada', role: 'Klerk' });
    const zoe = await store.createGezel({ name: 'Zoe', role: 'Meester' });

    await store.ensureDefaultMeester();

    const config = await store.readConfig();
    expect(config.meesterGezelId).toBe(zoe.id);
    expect(config.meesterGezelId).not.toBe(ada.id);
  });

  it('re-designates a stale pointer to the real Meester, not the first name', async () => {
    await store.createGezel({ name: 'Ada', role: 'Klerk' });
    const zoe = await store.createGezel({ name: 'Zoe', role: 'Meester' });
    await store.writeConfig({ meesterGezelId: 'ghost' });

    await store.ensureDefaultMeester();

    expect((await store.readConfig()).meesterGezelId).toBe(zoe.id);
  });

  it('re-designates when meesterGezelId points at a deleted gezel', async () => {
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.createGezel({ name: 'Boz', role: 'Writer' });
    // Point at a nonexistent id.
    await store.writeConfig({ meesterGezelId: 'ghost' });

    await store.ensureDefaultMeester();

    const config = await store.readConfig();
    expect(config.meesterGezelId).not.toBe('ghost');
    expect(['ada', 'boz']).toContain(config.meesterGezelId);
  });

  it('refreshes persisted two-macro guidance to the single project kickoff', async () => {
    const oldAbout = [
      '## Identity',
      'You are the Meester.',
      '## Starting work — two macros, one decision',
      'Use start_project for crews and start_job for a single specialist.',
      'Use ask_specialist for advice.',
    ].join('\n\n');
    const meester = await store.createGezel({ name: 'Mira', role: 'Meester', about: oldAbout });
    await store.writeConfig({ meesterGezelId: meester.id });

    await store.ensureDefaultMeester();

    expect((await store.getGezel(meester.id))?.about).toBe(MEESTER_ABOUT_MD);
    expect(MEESTER_ABOUT_MD).not.toContain('start_job');
  });
});

describe('Store.updateProject', () => {
  it('patches name + description in isolation', async () => {
    const p = await store.createProject({ name: 'Initial', description: 'first' });
    const out = await store.updateProject(p.id, { name: 'Renamed' });
    expect(out.name).toBe('Renamed');
    expect(out.description).toBe('first');

    const again = await store.updateProject(p.id, { description: 'updated' });
    expect(again.name).toBe('Renamed');
    expect(again.description).toBe('updated');
  });

  it('sets workingDir and clears it with null', async () => {
    const p = await store.createProject({ name: 'Work' });
    const set = await store.updateProject(p.id, { workingDir: '/tmp/external' });
    expect(set.workingDir).toBe('/tmp/external');

    const cleared = await store.updateProject(p.id, { workingDir: null });
    expect(cleared.workingDir).toBeUndefined();
  });

  it('assigns and clears voormanGezelId', async () => {
    const ada = await store.createGezel({ name: 'Ada', role: 'Developer' });
    const p = await store.createProject({ name: 'Alpha' });

    const assigned = await store.updateProject(p.id, { voormanGezelId: ada.id });
    expect(assigned.voormanGezelId).toBe(ada.id);

    const cleared = await store.updateProject(p.id, { voormanGezelId: null });
    expect(cleared.voormanGezelId).toBeUndefined();
  });

  it('writes about + missionObjectives to project documents folder', async () => {
    const p = await store.createProject({ name: 'Beta' });

    const out = await store.updateProject(p.id, {
      about: 'A focused project to ship X.',
      missionObjectives: '- Land Y\n- Avoid Z',
    });
    expect(out.about).toBe('A focused project to ship X.');
    expect(out.missionObjectives).toBe('- Land Y\n- Avoid Z');

    // Round-trip via fresh getProject.
    const fresh = await store.getProject(p.id);
    expect(fresh?.about).toBe('A focused project to ship X.');
    expect(fresh?.missionObjectives).toBe('- Land Y\n- Avoid Z');
  });

  it('about + missionObjectives are absent from getProject when never written', async () => {
    const p = await store.createProject({ name: 'Empty' });
    const fresh = await store.getProject(p.id);
    expect(fresh?.about).toBeUndefined();
    expect(fresh?.missionObjectives).toBeUndefined();
  });
});
