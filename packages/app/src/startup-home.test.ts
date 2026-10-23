import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StartupHomeHost } from './startup-home.js';

const homes: string[] = [];
async function home() {
  const path = await mkdtemp(join(tmpdir(), 'gezel-startup-'));
  homes.push(path);
  await writeFile(join(path, 'config.json'), '{}');
  await writeFile(
    join(path, 'startup-home.json'),
    JSON.stringify({ version: 1, savedAt: '2026-10-19', meester: { id: 'vanya', name: 'Vanya' } }),
  );
  return path;
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('startup home', () => {
  it('restores a bounded reading copy and keeps drafts until the live app acknowledges their exact text', async () => {
    const path = await home();
    const host = new StartupHomeHost();
    await host.load(path);
    expect(host.snapshot?.meester?.name).toBe('Vanya');
    host.save({
      ...host.state,
      tab: 'tour',
      article: 2,
      scroll: 240,
      draft: '  Keep this\nexactly.  ',
    });
    expect(host.finish('older text')).toBe(false);
    await host.flush();
    const reopened = new StartupHomeHost();
    await reopened.load(path);
    expect(reopened.state).toMatchObject({
      tab: 'tour',
      article: 2,
      scroll: 240,
      draft: '  Keep this\nexactly.  ',
    });
    expect(reopened.finish(reopened.state.draft)).toBe(true);
    await reopened.flush();
    const again = new StartupHomeHost();
    await again.load(path);
    expect(again.state.draft).toBe('');
  });

  it('isolates local and remote drafts and never shows local content for a remote connection', async () => {
    const path = await home();
    const local = new StartupHomeHost();
    await local.load(path);
    local.save({ ...local.state, draft: 'local private draft' });
    await local.flush();
    await writeFile(
      join(path, 'config.json'),
      JSON.stringify({ service: { url: 'https://other:6228', token: 'secret' } }),
    );
    const remote = new StartupHomeHost();
    await remote.load(path);
    expect(remote.snapshot).toBeNull();
    expect(remote.state.draft).toBe('');
    remote.save({ ...remote.state, draft: 'remote draft' });
    await remote.flush();
    for (const file of await readdir(join(path, 'desktop'))) {
      expect(await readFile(join(path, 'desktop', file), 'utf8')).not.toContain('secret');
    }
  });

  it('rejects corrupt, oversized and unsupported cache data without blocking launch', async () => {
    const path = await home();
    for (const content of ['{oops', JSON.stringify({ version: 9 }), ' '.repeat(256_001)]) {
      await writeFile(join(path, 'startup-home.json'), content);
      const host = new StartupHomeHost();
      await host.load(path);
      expect(host.snapshot).toBeNull();
      expect(host.save({ ...host.state, draft: 'x'.repeat(32_001) })).toBe(false);
    }
    await writeFile(join(path, 'config.json'), JSON.stringify({ service: { url: 42 } }));
    const host = new StartupHomeHost();
    await expect(host.load(path)).resolves.toBeUndefined();
    expect(host.snapshot).toBeNull();
  });
});
