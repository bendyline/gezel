import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialPoppetjeForGezel } from '@bendyline/gezel/poppetje';
import { afterEach, expect, it } from 'vitest';
import { StartupHomeCache } from './startup-home.js';

let home: string;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});
it('saves the actual Meester character and display preference for the local screen', async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-startup-character-'));
  const cache = new StartupHomeCache(home);
  const poppetje = initialPoppetjeForGezel('vanya', 'Vanya');
  const source = {
    readConfig: async () => ({ meesterGezelId: 'vanya', showPoppetjes: false, themePref: 'dark' }),
    getGezel: async () => ({ id: 'vanya', name: 'Vanya', poppetje }),
    readMeesterStatus: async () => null,
  } as unknown as Parameters<StartupHomeCache['refresh']>[0];
  await cache.refresh(source);
  expect(await cache.read()).toMatchObject({
    meester: { id: 'vanya', name: 'Vanya', poppetje },
    showPoppetjes: false,
    theme: 'dark',
  });
});
it('serializes independent updates without losing a report or replacing a newer user message', async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-startup-cache-'));
  const cache = new StartupHomeCache(home);
  await cache.update({ meester: { id: 'vanya', name: 'Vanya' } });
  await Promise.all([
    cache.update({
      status: { headline: 'Your report is ready', content: 'Read it here.', at: '2026-10-19' },
    }),
    cache.update({ lastMessage: { content: 'latest', at: '2026-10-19' } }),
    cache.update({ night: { completed: 2, windowEnd: '2026-10-19', reports: [] } }),
    cache.update({ lastMessage: { content: 'old', at: '2026-10-18' } }),
  ]);
  const saved = await cache.read();
  expect(saved?.status?.headline).toBe('Your report is ready');
  expect(saved?.night?.completed).toBe(2);
  expect(saved?.lastMessage?.content).toBe('latest');
  await cache.update({ meester: { id: 'other', name: 'Other' } });
  expect((await cache.read())?.lastMessage).toBeNull();
});

// The start screen drew the greeting sheet for about ten seconds, then the
// app swapped in the welcome a never-used home opens on (2026-11-09 review).
it('records whether Home will open on the welcome, and never forgets a home was used', async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-startup-welcome-'));
  const cache = new StartupHomeCache(home);
  let sessions = false;
  let projects = [{ id: 'default' }, { id: 'shared', properties: { 'gezel.sharedLibrary': '1' } }];
  const source = {
    readConfig: async () => ({ meesterGezelId: 'vanya' }),
    getGezel: async () => ({ id: 'vanya', name: 'Vanya' }),
    readMeesterStatus: async () => null,
    hasAnySession: async () => sessions,
    listProjects: async () => projects,
  } as unknown as Parameters<StartupHomeCache['refresh']>[0];

  await cache.refresh(source);
  expect((await cache.read())?.welcome).toBe(true);

  projects = [...projects, { id: 'bakery' }];
  await cache.refresh(source);
  expect((await cache.read())?.welcome).toBe(false);

  projects = projects.slice(0, 2);
  await cache.refresh(source);
  expect((await cache.read())?.welcome).toBe(false);

  const fresh = new StartupHomeCache(await mkdtemp(join(tmpdir(), 'gezel-startup-welcome-')));
  sessions = true;
  await fresh.refresh(source);
  expect((await fresh.read())?.welcome).toBe(false);
});

it('stops welcoming once the person writes to the Meester', async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-startup-first-message-'));
  const cache = new StartupHomeCache(home);
  await cache.update({ meester: { id: 'vanya', name: 'Vanya' }, welcome: true });
  await cache.cacheSession({
    id: 's1',
    messages: [{ role: 'user', content: 'Plan a trip to Kyoto', at: '2026-11-10T10:00:00Z' }],
  } as never);
  expect((await cache.read())?.welcome).toBe(false);
});
