import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOfficeHostListener } from '../office-host/listener.js';
import { type CreateOfficeSetupManagerOptions, createOfficeSetupManager } from './manager.js';

let home: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel office home '));
});
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

function makeManager(overrides: Partial<CreateOfficeSetupManagerOptions> & { port?: number } = {}) {
  const listener = createOfficeHostListener({
    fetch: () => async (req: Request) => new Response(`ok ${new URL(req.url).pathname}`),
    port: overrides.port ?? 0,
  });
  const manager = createOfficeSetupManager({
    home,
    listener,
    paneAvailable: () => true,
    platform: 'darwin',
    version: '1.2.3',
    detect: async () => ({
      hostSupported: true,
      apps: { word: true, excel: true, powerpoint: false },
    }),
    reconcileIntervalMs: 60 * 60 * 1000,
    ...overrides,
  });
  cleanups.push(() => manager.stop());
  return { manager, listener };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function httpsGet(
  origin: string,
  path: string,
  ca: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path: url.pathname, ca, servername: 'localhost' },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('office setup manager', () => {
  it('starts not configured', async () => {
    const { manager } = makeManager();
    const status = await manager.status();
    expect(status.state).toBe('not-configured');
    expect(status.hostSupported).toBe(true);
    expect(status.officeInstalled).toBe(true);
    expect(status.apps.map((a) => [a.app, a.detected, a.selected])).toEqual([
      ['word', true, false],
      ['excel', true, false],
      ['powerpoint', false, false],
    ]);
    expect(manager.origin()).toBeNull();
  });

  it('configures: identity, a trusted HTTPS listener, and manifests for the chosen apps', async () => {
    const { manager } = makeManager();
    const status = await manager.configure({ apps: ['word', 'excel'] });
    expect(status.listener.state).toBe('listening');
    const origin = manager.origin()!;
    expect(origin).toMatch(/^https:\/\/localhost:\d+$/);
    expect(status.trust.caPem).toContain('BEGIN CERTIFICATE');
    expect(status.trust.caSha1).toMatch(/^[0-9a-f]{40}$/);
    expect(status.trust.installed).toBeNull();
    expect(status.state).toBe('update-needed');

    const word = status.apps.find((a) => a.app === 'word')!;
    expect(word.selected).toBe(true);
    expect(word.manifestPath).toBeDefined();
    const xml = await readFile(word.manifestPath!, 'utf8');
    expect(xml).toContain(`${origin}/office/word/taskpane.html`);
    expect(xml).toContain(`<Id>${word.manifestId}</Id>`);
    expect(status.apps.find((a) => a.app === 'powerpoint')?.manifestPath).toBeUndefined();

    // A client that trusts only the Office CA can reach the listener by name.
    const res = await httpsGet(origin, '/office/word/taskpane.html', status.trust.caPem!);
    expect(res).toEqual({ status: 200, body: 'ok /office/word/taskpane.html' });
  });

  it('becomes configured once the desktop app reports trust and registration', async () => {
    const { manager } = makeManager();
    await manager.configure({ apps: ['word'] });
    const status = await manager.recordHostReport({
      trust: { installed: true },
      apps: { word: { registered: true } },
    });
    expect(status.state).toBe('configured');
    expect(status.reasons).toEqual([]);
  });

  it('keeps manifest ids across reconfiguration and drops deselected apps', async () => {
    const { manager } = makeManager();
    const first = await manager.configure({ apps: ['word', 'excel'] });
    await manager.recordHostReport({
      trust: { installed: true },
      apps: { word: { registered: true }, excel: { registered: true } },
    });
    const second = await manager.configure({ apps: ['word'] });
    const id = (s: typeof first, app: string) => s.apps.find((a) => a.app === app)?.manifestId;
    expect(id(second, 'word')).toBe(id(first, 'word'));
    expect(id(second, 'excel')).toBe(id(first, 'excel'));
    expect(second.apps.find((a) => a.app === 'excel')?.manifestPath).toBeUndefined();
    expect(second.apps.find((a) => a.app === 'word')?.registered).toBe(true);
    expect(second.trust.installed).toBe(true);
    expect(second.state).toBe('configured');
  });

  it('asks for re-registration when a manifest changes (new app version)', async () => {
    const first = makeManager();
    await first.manager.configure({ apps: ['word'] });
    await first.manager.recordHostReport({
      trust: { installed: true },
      apps: { word: { registered: true } },
    });
    await first.manager.stop();

    const upgraded = makeManager({ version: '1.2.4' });
    await upgraded.manager.reconcile();
    const status = await upgraded.manager.status();
    expect(status.listener.state).toBe('listening');
    expect(status.trust.installed).toBe(true);
    expect(status.apps.find((a) => a.app === 'word')?.registered).toBeNull();
    expect(status.state).toBe('update-needed');
  });

  it('renews the leaf without asking the user to trust again', async () => {
    const now = new Date();
    // Production ports are stable per home; pin one so the manifests do not move.
    const port = await freePort();
    const first = makeManager({ now: () => now, port });
    const before = await first.manager.configure({ apps: ['word'] });
    await first.manager.recordHostReport({
      trust: { installed: true },
      apps: { word: { registered: true } },
    });
    await first.manager.stop();

    const later = new Date(now.getTime() + 750 * 24 * 60 * 60 * 1000);
    const second = makeManager({ now: () => later, port });
    await second.manager.reconcile();
    const status = await second.manager.status();
    expect(status.trust.caSha256).toBe(before.trust.caSha256);
    expect(status.trust.installed).toBe(true);
    expect(status.leafNotAfter).not.toBe(before.leafNotAfter);
    expect(status.state).toBe('configured');
  });

  it('removes everything and stops listening', async () => {
    const { manager } = makeManager();
    await manager.configure({ apps: ['word'] });
    const status = await manager.remove();
    expect(status.state).toBe('not-configured');
    expect(status.listener.state).toBe('stopped');
    expect(manager.origin()).toBeNull();
    await expect(readFile(join(home, 'integrations', 'office', 'setup.json'))).rejects.toThrow();
  });

  it('refuses unsupported platforms and builds without the pane', async () => {
    const linux = makeManager({ platform: 'linux' });
    await expect(linux.manager.configure({ apps: ['word'] })).rejects.toMatchObject({
      code: 'office_unsupported',
      status: 400,
    });
    expect((await linux.manager.status()).state).toBe('unavailable');

    const noPane = makeManager({ paneAvailable: () => false });
    await expect(noPane.manager.configure({ apps: ['word'] })).rejects.toMatchObject({
      code: 'office_pages_missing',
    });
    expect((await noPane.manager.status()).state).toBe('unavailable');
  });

  it('reports a taken port and rolls back a first setup', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const port = (blocker.address() as { port: number }).port;
    const { manager } = makeManager({ port });
    await expect(manager.configure({ apps: ['word'] })).rejects.toMatchObject({
      code: 'office_port_in_use',
    });
    await expect(readFile(join(home, 'integrations', 'office', 'ca.pem'))).rejects.toThrow();
    expect((await manager.status()).state).toBe('not-configured');
  });

  it('reports a damaged record as a conflict that can be removed', async () => {
    const { manager } = makeManager();
    await manager.configure({ apps: ['word'] });
    // Both the record and the backup readSecurityJson would recover from.
    await writeFile(join(home, 'integrations', 'office', 'setup.json'), '{"version": 99}');
    await writeFile(join(home, 'integrations', 'office', 'setup.json.bak'), '{"version": 99}');
    const status = await manager.status();
    expect(status.state).toBe('conflict');
    expect(status.canRemove).toBe(true);
  });
});
