import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GezelSummary,
  PiSetupStatusResponseSchema,
  type ProviderName,
} from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { setupOwnerId } from '../fs/managed-marker.js';
import type { PiBridgeController } from '../http/pi-bridge.js';
import { createTokenStore } from '../http/token-store.js';
import type { ModelInfo } from '../providers/types.js';
import { PI_EXTENSION_MARKER } from './extension-source.js';
import { PI_SETUP_APP_ID, createPiSetupManager } from './manager.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  opts: {
    endpointsEnabled?: boolean;
    gezels?: GezelSummary[];
    defaultModel?: Partial<Record<ProviderName, string>>;
    meesterGezelId?: string;
    piInstalled?: boolean;
    platform?: NodeJS.Platform;
    /** Share one pi agent root between two Gezel homes. */
    piAgentDir?: string;
    models?: ModelInfo[];
  } = {},
) {
  // The space is deliberate. A Windows home is routinely `C:\Users\Mike Smith`,
  // and it is the only reason the launch command quotes at all — a fixture
  // rooted at a bare path exercises the shell-quoting branch on no platform.
  const root = await mkdtemp(join(tmpdir(), 'gezel pi setup '));
  roots.push(root);
  const home = join(root, 'gezel');
  const integrationDir = join(home, 'integrations', 'pi');
  // Stand in for pi's own agent root. Never let a test resolve the real one —
  // the installed extension is the single artifact written outside GEZEL_HOME.
  const piAgentDir = opts.piAgentDir ?? join(root, 'pi-agent');
  await mkdir(home, { recursive: true });
  const tokenStore = await createTokenStore({ home, rootToken: 'root-test' });
  let listening = false;
  const port = 24_680;
  const bridge: PiBridgeController = {
    status: () => (listening ? { listening: true, port } : { listening: false }),
    desiredPort: () => port,
    baseUrl: () => `http://127.0.0.1:${port}`,
    start: async () => {
      listening = true;
      return { listening: true, port };
    },
    stop: async () => {
      listening = false;
    },
  };
  const endpointsEnabled = opts.endpointsEnabled ?? true;
  const manager = createPiSetupManager({
    home,
    ...(opts.platform ? { platform: opts.platform } : {}),
    piAgentDir,
    tokenStore,
    bridge,
    readConfig: async () => ({
      openaiEndpoints: endpointsEnabled ? {} : { enabled: false },
      ...(opts.defaultModel ? { defaultModel: opts.defaultModel } : {}),
      ...(opts.meesterGezelId ? { meesterGezelId: opts.meesterGezelId } : {}),
    }),
    listGezels: async () => opts.gezels ?? [],
    providerForGezel: async (gezelId) =>
      opts.gezels?.find((candidate) => candidate.id === gezelId)?.provider ?? 'llama-cpp',
    listModels: async (provider) =>
      provider === 'llama-cpp'
        ? (opts.models ?? [
            {
              id: 'coder.gguf',
              name: 'Local Coder',
              supportsTools: true,
              supportsReasoning: false,
              contextWindow: 16_384,
            },
            { id: 'chatty.gguf', name: 'Chatty', supportsTools: false, contextWindow: 8_192 },
          ])
        : [],
    detectPi: async () =>
      opts.piInstalled === false
        ? { installed: false, error: 'pi was not found on PATH.' }
        : { installed: true, path: '/usr/local/bin/pi', version: '0.84.2' },
    now: () => new Date('2026-08-16T00:00:00.000Z'),
  });
  return {
    root,
    home,
    tokenStore,
    manager,
    integrationDir,
    rosterPath: join(integrationDir, 'models.json'),
    tokenPath: join(integrationDir, 'token'),
    extensionPath: join(integrationDir, 'gezel.js'),
    piAgentDir,
    installedPath: join(piAgentDir, 'extensions', 'gezel.js'),
    isListening: () => listening,
  };
}

const maya: GezelSummary = {
  id: 'maya-stable-id',
  name: 'Maya',
  role: 'Developer',
  provider: 'llama-cpp',
  model: 'coder.gguf',
  updatedAt: '2026-08-16T00:00:00.000Z',
};

describe('PiSetupManager', () => {
  it('offers eligible gezels ahead of raw models and drops tool-less ones', async () => {
    const f = await fixture({ gezels: [maya], meesterGezelId: maya.id });

    const before = await f.manager.status();

    expect(PiSetupStatusResponseSchema.parse(before)).toBeTruthy();
    expect(before.state).toBe('not-configured');
    expect(before.recommendedModel).toBe(`gezel:${maya.id}`);
    expect(before.models.map((model) => model.id)).toEqual([
      `gezel:${maya.id}`,
      'llama-cpp:coder.gguf',
    ]);
  });

  it('publishes a roster and an extension the launch command points at', async () => {
    // Pin the platform: the launch command's quoting is platform-conditional,
    // and an unpinned fixture asserts whatever the developer happens to run on.
    const f = await fixture({ gezels: [maya], platform: 'darwin' });

    const status = await f.manager.configure({ model: `gezel:${maya.id}` });

    const roster = JSON.parse(await readFile(f.rosterPath, 'utf8')) as {
      provider: { id: string; api: string; baseUrl: string; models: Array<{ id: string }> };
      defaultModel: string;
    };
    expect(roster.provider.id).toBe('gezel');
    expect(roster.provider.api).toBe('openai-completions');
    expect(roster.provider.baseUrl).toBe('http://127.0.0.1:24680/v1');
    expect(roster.provider.models.map((model) => model.id)).toEqual([
      `gezel:${maya.id}`,
      'llama-cpp:coder.gguf',
    ]);
    expect(roster.defaultModel).toBe(`gezel:${maya.id}`);

    // The credential is referenced by path, never copied into the roster.
    const token = await readFile(f.tokenPath, 'utf8');
    expect(token).not.toMatch(/\s$/);
    expect(await readFile(f.rosterPath, 'utf8')).not.toContain(token);

    expect(status.launchCommand).toBe(`/usr/local/bin/pi -e '${f.extensionPath}'`);
    expect(existsSync(f.extensionPath)).toBe(true);
    // Command mode must leave pi's own directory completely alone.
    expect(existsSync(f.piAgentDir)).toBe(false);
    expect(status.extension.state).toBe('not-installed');
    expect(status.state).toBe('configured');
  });

  it('builds the launch command for each platform', async () => {
    // Each branch is reached on exactly one platform in production, so whichever
    // one the developer runs is the only one an unpinned fixture would cover.
    const posix = await fixture({ gezels: [maya], platform: 'darwin' });
    const windows = await fixture({ gezels: [maya], platform: 'win32' });

    const posixStatus = await posix.manager.status();
    const windowsStatus = await windows.manager.status();

    expect(posixStatus.launchCommand).toBe(`/usr/local/bin/pi -e '${posix.extensionPath}'`);
    // PowerShell needs the call operator before a quoted executable path, and
    // the whole thing is one line the user pastes — so assert it whole.
    expect(windowsStatus.launchCommand).toBe(`& '/usr/local/bin/pi' -e '${windows.extensionPath}'`);
  });

  it('adds the extension to pi only when asked', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: `gezel:${maya.id}` });

    const status = await f.manager.installExtension({});

    expect(status.extension.state).toBe('installed');
    expect(status.extension.canRemove).toBe(true);
    expect(status.extension.agentDirSource).toBe('override');
    const installed = await readFile(f.installedPath, 'utf8');
    expect(PI_EXTENSION_MARKER.isManaged(installed, setupOwnerId(f.home))).toBe(true);
    expect(installed).toBe(await readFile(f.extensionPath, 'utf8'));
    expect(installed).not.toContain(await readFile(f.tokenPath, 'utf8'));
  });

  it('refuses to add the extension before the roster exists', async () => {
    const f = await fixture({ gezels: [maya] });

    await expect(f.manager.installExtension({})).rejects.toMatchObject({
      code: 'pi_not_configured',
    });
    expect(existsSync(f.installedPath)).toBe(false);
  });

  it('refuses to add the extension when pi is not on this computer', async () => {
    const f = await fixture({ gezels: [maya], piInstalled: false });
    await f.manager.configure({ model: `gezel:${maya.id}` });

    expect((await f.manager.status()).extension.state).toBe('unsupported');
    await expect(f.manager.installExtension({})).rejects.toMatchObject({
      code: 'pi_not_installed',
    });
  });

  it('adding twice is idempotent', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: `gezel:${maya.id}` });
    await f.manager.installExtension({});
    const first = await stat(f.installedPath);

    const status = await f.manager.installExtension({});

    expect(status.extension.state).toBe('installed');
    expect((await stat(f.installedPath)).mtimeMs).toBe(first.mtimeMs);
  });

  it('leaves a foreign extension alone without blocking the rest of the card', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: `gezel:${maya.id}` });
    await mkdir(join(f.piAgentDir, 'extensions'), { recursive: true });
    await writeFile(f.installedPath, '// someone else wrote this\n', 'utf8');

    const status = await f.manager.status();

    expect(status.extension.state).toBe('conflict');
    expect(status.extension.canInstall).toBe(false);
    expect(status.extension.canReplace).toBe(true);
    // A stray file in the user's pi directory is not a reason to block the
    // managed roster the card is actually about.
    expect(status.state).toBe('configured');
    expect(status.canConfigure).toBe(true);
    await expect(f.manager.installExtension({})).rejects.toMatchObject({
      code: 'pi_extension_conflict',
    });
    expect(await readFile(f.installedPath, 'utf8')).toBe('// someone else wrote this\n');
    await expect(f.manager.removeExtension()).rejects.toMatchObject({
      code: 'pi_extension_conflict',
    });
    expect(existsSync(f.installedPath)).toBe(true);
  });

  it('replaces a foreign extension only when asked, keeping a backup', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: `gezel:${maya.id}` });
    await mkdir(join(f.piAgentDir, 'extensions'), { recursive: true });
    await writeFile(f.installedPath, '// someone else wrote this\n', 'utf8');

    const status = await f.manager.installExtension({ backupConflictingExtension: true });

    expect(status.extension.state).toBe('installed');
    expect(status.extensionBackupPath).toBe(`${f.installedPath}.backup`);
    expect(await readFile(`${f.installedPath}.backup`, 'utf8')).toBe(
      '// someone else wrote this\n',
    );
  });

  it('treats another Gezel home’s extension as foreign', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'gezel-pi-shared-'));
    roots.push(shared);
    const first = await fixture({ gezels: [maya], piAgentDir: shared });
    const second = await fixture({ gezels: [maya], piAgentDir: shared });
    await first.manager.configure({ model: `gezel:${maya.id}` });
    await first.manager.installExtension({});
    await second.manager.configure({ model: `gezel:${maya.id}` });

    expect((await second.manager.status()).extension.state).toBe('conflict');
    await expect(second.manager.removeExtension()).rejects.toMatchObject({
      code: 'pi_extension_conflict',
    });
    // The other install's extension must survive a wholesale teardown here.
    await second.manager.remove();
    expect(existsSync(first.installedPath)).toBe(true);
  });

  it('repairs a stale extension without recreating a deleted one', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: `gezel:${maya.id}` });
    await f.manager.installExtension({});
    const published = await readFile(f.installedPath, 'utf8');
    await writeFile(
      f.installedPath,
      PI_EXTENSION_MARKER.build('// an older Gezel wrote this body\n', setupOwnerId(f.home)),
      'utf8',
    );

    const stale = await f.manager.status();
    expect(stale.extension.state).toBe('stale');
    expect(stale.state).toBe('update-needed');
    expect(stale.reasons).toContain('The extension added to pi is out of date.');

    await f.manager.reconcile();
    expect(await readFile(f.installedPath, 'utf8')).toBe(published);

    await f.manager.removeExtension();
    await f.manager.reconcile();
    // Re-materialising a file in the user's own pi directory behind their back
    // is the one thing this must never do.
    expect(existsSync(f.installedPath)).toBe(false);
  });

  it('removes the installed extension along with the rest of the setup', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: `gezel:${maya.id}` });
    await f.manager.installExtension({});

    const status = await f.manager.remove();

    expect(existsSync(f.installedPath)).toBe(false);
    expect(existsSync(f.integrationDir)).toBe(false);
    expect(status.extension.state).toBe('not-installed');
    expect(f.tokenStore.list().some((record) => record.appId === PI_SETUP_APP_ID)).toBe(false);
    expect(f.isListening()).toBe(false);
  });

  it('refuses to serve when the managed roster was tampered with', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: `gezel:${maya.id}` });
    await writeFile(f.rosterPath, '{"provider":{"id":"someone-else"}}\n', 'utf8');

    await f.manager.reconcile();

    expect(f.isListening()).toBe(false);
    expect((await f.manager.status()).state).toBe('conflict');
  });

  it('does not publish while connected-app serving is off', async () => {
    const f = await fixture({ gezels: [maya], endpointsEnabled: false });

    await expect(f.manager.configure({ model: `gezel:${maya.id}` })).rejects.toMatchObject({
      code: 'openai_endpoints_disabled',
    });
    expect(existsSync(f.rosterPath)).toBe(false);
  });
});
