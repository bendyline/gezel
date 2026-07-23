import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DebugFlag } from '../debug/flag.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChannelManager } from './manager.js';

let home: string;
let store: Store;
let history: HistoryManager;
let secrets: FileSecretStore;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-channels-test-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  secrets = new FileSecretStore(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function makeManager() {
  const m = new ChannelManager({ store, secrets, history, debug: new DebugFlag(false) });
  await m.start();
  return m;
}

describe('ChannelManager', () => {
  it('starts cleanly with no channels configured', async () => {
    const m = await makeManager();
    const list = await m.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('webhook');
    expect(list[0]!.configured).toBe(false);
    expect(list[0]!.ready).toBe(false);
    const result = await m.send('hello');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no channel configured/);
    await m.stop();
  });

  it('reports the webhook channel as ready once configured', async () => {
    await store.writeConfig({
      channels: { webhook: { url: 'https://example.test/h' } },
    });
    const m = await makeManager();
    const list = await m.list();
    expect(list[0]!.configured).toBe(true);
    expect(list[0]!.ready).toBe(true);
    await m.stop();
  });

  it('reconfigure picks up a new webhook URL', async () => {
    const m = await makeManager();
    expect((await m.list())[0]!.configured).toBe(false);
    await store.writeConfig({
      channels: { webhook: { url: 'https://example.test/h' } },
    });
    await m.reconfigure();
    expect((await m.list())[0]!.configured).toBe(true);
    await m.stop();
  });

  it('logs channel.message.sent on success and .failed on error', async () => {
    await store.writeConfig({
      channels: { webhook: { url: 'https://example.test/h' } },
    });
    const m = await makeManager();

    const globalThisAsAny = globalThis as unknown as { fetch: typeof fetch };
    const originalFetch = globalThisAsAny.fetch;
    try {
      // success path
      globalThisAsAny.fetch = (async () =>
        ({ ok: true, status: 200, text: async () => '' }) as Response) as typeof fetch;
      const ok = await m.send('hi', { channel: 'webhook', source: 'test' });
      expect(ok.ok).toBe(true);

      // failure path
      globalThisAsAny.fetch = (async () => {
        throw new Error('boom');
      }) as typeof fetch;
      const fail = await m.send('hi', { channel: 'webhook', source: 'test' });
      expect(fail.ok).toBe(false);
    } finally {
      globalThisAsAny.fetch = originalFetch;
    }

    const events = await history.listEvents();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('channel.message.sent');
    expect(kinds).toContain('channel.message.failed');
    await m.stop();
  });
});
