import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

/**
 * Covers the New Project flow's wire change: `createProject` now
 * accepts an optional `github: { url }` and persists it into
 * `project.json` so the GitHub manager can pick up the link
 * immediately. The clone itself isn't kicked off here — that lives
 * in the HTTP route handler — but the field round-trips through
 * disk reads.
 */

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-project-github-test-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Store.createProject — github field', () => {
  it('persists the github url onto a freshly-created project', async () => {
    const created = await store.createProject({
      name: 'Demo',
      about:
        'This project demonstrates a thing. It is meant to be used by the team for a specific scope.',
      missionObjectives: '- ship the demo - cover the happy path - document the result',
      github: { url: 'https://github.com/octocat/Hello-World' },
    });
    expect(created.github?.url).toBe('https://github.com/octocat/Hello-World');

    // Re-read from disk to confirm persistence.
    const reloaded = await store.getProject(created.id);
    expect(reloaded?.github?.url).toBe('https://github.com/octocat/Hello-World');
  });

  it('omits the github field on disk when no url is supplied', async () => {
    const created = await store.createProject({
      name: 'Plain',
      about:
        'No GitHub link here, just a plain project. Persistence should not produce an empty object.',
      missionObjectives: '- run the basics - confirm shape - move on',
    });
    expect(created.github).toBeUndefined();
    const reloaded = await store.getProject(created.id);
    expect(reloaded?.github).toBeUndefined();
  });

  it('can link github metadata after an explicit clone creates the project first', async () => {
    const created = await store.createProject({
      name: 'Fetched Later',
      about:
        'The repository will be fetched after project creation to avoid background clone races.',
      missionObjectives: '- create project - clone repo - persist github metadata',
    });
    expect(created.github).toBeUndefined();

    await store.updateProjectGithub(created.id, {
      url: 'https://github.com/bendyline/squisq',
      checkoutDir: join(home, 'projects', created.id, 'workspace'),
    });

    const reloaded = await store.getProject(created.id);
    expect(reloaded?.github?.url).toBe('https://github.com/bendyline/squisq');
    expect(reloaded?.github?.checkoutDir).toBe(join(home, 'projects', created.id, 'workspace'));
  });
});
