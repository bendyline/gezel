import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { StartupHomeCache } from './startup-home.js';

let home: string;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
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
