import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezappManifest, ImportAiAppResult } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseParamFlags,
  runAppAdd,
  runAppApply,
  runAppList,
  runAppRemove,
  runAppServe,
  runAppSetEnabled,
  runAppStatus,
  runAppUpdate,
} from './app-command.js';

let dir: string;
let file: string;
let logged: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-app-cmd-'));
  file = join(dir, 'fixture.gezapp');
  await writeFile(file, Buffer.from('not-a-real-archive'));
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function manifest(version: string): GezappManifest {
  return {
    format: 'gezel-ai-app',
    schemaVersion: 1,
    entry: { projectType: 'demo-app', version },
    name: 'Demo App',
    description: 'a demo',
    publisher: { name: 'Test' },
    createdAt: new Date().toISOString(),
    signature: { status: 'unsigned' },
    items: [{ kind: 'project-type', id: 'demo-app', version, sha256: 'a'.repeat(64) }],
    dependencies: [],
  };
}

function importResult(version: string, extra?: Partial<ImportAiAppResult>): ImportAiAppResult {
  return {
    manifest: manifest(version),
    items: [{ kind: 'project-type', id: 'demo-app', version }],
    dependencies: [],
    missingDependencies: [],
    packageSha256: 'b'.repeat(64),
    ...extra,
  };
}

function stubClient(overrides: Partial<Record<keyof GezelClient, unknown>>): GezelClient {
  return overrides as unknown as GezelClient;
}

function apiError(status: number, message: string): Error {
  const err = new Error(`Gezel API error ${status}`);
  (err as Error & { details: unknown }).details = { error: message };
  return err;
}

describe('runAppAdd', () => {
  it('refuses a downgrade without --force', async () => {
    const client = stubClient({
      importAiAppPackage: vi
        .fn()
        .mockResolvedValue(
          importResult('1.0.0', { previous: { version: '2.0.0', enabled: true } }),
        ),
    });
    await expect(runAppAdd(client, file, { yes: true })).rejects.toThrow(/refusing to downgrade/);
  });

  it('downgrades with --force', async () => {
    const importAiAppPackage = vi
      .fn()
      .mockResolvedValueOnce(
        importResult('1.0.0', { previous: { version: '2.0.0', enabled: true } }),
      )
      .mockResolvedValueOnce(
        importResult('1.0.0', {
          previous: { version: '2.0.0', enabled: true },
          installed: {
            appId: 'demo-app',
            version: '1.0.0',
            receiptPath: '/x',
            alreadyPresent: false,
          },
        }),
      );
    const client = stubClient({ importAiAppPackage });
    await runAppAdd(client, file, { yes: true, force: true });
    expect(importAiAppPackage).toHaveBeenNthCalledWith(2, expect.anything(), { confirm: true });
    expect(logged.join('\n')).toContain('Installed demo-app@1.0.0');
  });

  it('refuses without confirmation when stdin is not a TTY', async () => {
    const client = stubClient({
      importAiAppPackage: vi.fn().mockResolvedValue(importResult('1.0.0')),
    });
    await expect(runAppAdd(client, file, {})).rejects.toThrow(/Pass --yes/);
  });

  it('reports an idempotent re-install as a no-op', async () => {
    const done = importResult('1.0.0', {
      previous: { version: '1.0.0', enabled: true },
      installed: { appId: 'demo-app', version: '1.0.0', receiptPath: '/x', alreadyPresent: true },
    });
    const client = stubClient({ importAiAppPackage: vi.fn().mockResolvedValue(done) });
    await runAppAdd(client, file, { yes: true });
    expect(logged.join('\n')).toContain('already installed — no changes');
  });

  it('fails cleanly on an unreadable file', async () => {
    const client = stubClient({});
    await expect(runAppAdd(client, join(dir, 'missing.gezapp'), { yes: true })).rejects.toThrow(
      /cannot read \.gezapp file/,
    );
  });
});

describe('runAppUpdate', () => {
  it('requires the app to be installed', async () => {
    const client = stubClient({
      importAiAppPackage: vi.fn().mockResolvedValue(importResult('1.0.0')),
    });
    await expect(runAppUpdate(client, file, {})).rejects.toThrow(/use `gezel app add`/);
  });

  it('reports an equal-version identical package as up to date', async () => {
    const importAiAppPackage = vi
      .fn()
      .mockResolvedValueOnce(
        importResult('1.0.0', { previous: { version: '1.0.0', enabled: true } }),
      )
      .mockResolvedValueOnce(
        importResult('1.0.0', {
          previous: { version: '1.0.0', enabled: true },
          installed: {
            appId: 'demo-app',
            version: '1.0.0',
            receiptPath: '/x',
            alreadyPresent: true,
          },
        }),
      );
    const client = stubClient({ importAiAppPackage });
    await runAppUpdate(client, file, {});
    expect(logged.join('\n')).toContain('already up to date');
  });

  it('refuses a downgrade without --force', async () => {
    const client = stubClient({
      importAiAppPackage: vi
        .fn()
        .mockResolvedValue(
          importResult('1.0.0', { previous: { version: '2.0.0', enabled: true } }),
        ),
    });
    await expect(runAppUpdate(client, file, {})).rejects.toThrow(/refusing to downgrade/);
  });
});

describe('runAppList', () => {
  it('prints a hint when nothing is installed', async () => {
    const client = stubClient({ listAiApps: vi.fn().mockResolvedValue({ apps: [] }) });
    await runAppList(client, {});
    expect(logged.join('\n')).toContain('No AI Apps installed');
  });

  it('prints one row per app', async () => {
    const client = stubClient({
      listAiApps: vi.fn().mockResolvedValue({
        apps: [
          {
            appId: 'demo-app',
            version: '1.2.0',
            packageSha256: 'b'.repeat(64),
            installedAt: '2026-08-01T00:00:00.000Z',
            enabled: false,
            name: 'Demo App',
            description: 'a demo',
            publisher: { name: 'Test' },
            itemCount: 1,
            dependencyCount: 0,
            versionsOnDisk: ['1.2.0'],
          },
        ],
      }),
    });
    await runAppList(client, {});
    const out = logged.join('\n');
    expect(out).toContain('demo-app');
    expect(out).toContain('1.2.0');
    expect(out).toContain('disabled');
  });
});

describe('runAppRemove', () => {
  it('errors on an unknown app', async () => {
    const client = stubClient({ listAiApps: vi.fn().mockResolvedValue({ apps: [] }) });
    await expect(runAppRemove(client, 'nope', { yes: true })).rejects.toThrow(
      /AI App not found: nope/,
    );
  });

  it('reports removed versions and outfitted projects', async () => {
    const client = stubClient({
      listAiApps: vi.fn().mockResolvedValue({
        apps: [
          {
            appId: 'demo-app',
            version: '1.0.0',
            packageSha256: 'b'.repeat(64),
            installedAt: '2026-08-01T00:00:00.000Z',
            enabled: true,
            name: 'Demo App',
            description: '',
            publisher: null,
            itemCount: 1,
            dependencyCount: 0,
            versionsOnDisk: ['1.0.0'],
          },
        ],
      }),
      removeAiApp: vi.fn().mockResolvedValue({
        appId: 'demo-app',
        removedVersions: ['1.0.0'],
        keptVersions: [],
        appliedProjects: [{ id: 'p1', name: 'Spanish', version: '1.0.0' }],
      }),
    });
    await runAppRemove(client, 'demo-app', { yes: true });
    const out = logged.join('\n');
    expect(out).toContain('Uninstalled demo-app (removed 1.0.0)');
    expect(out).toContain('1 project(s) were outfitted');
  });
});

describe('runAppSetEnabled', () => {
  it('surfaces the daemon error message', async () => {
    const client = stubClient({
      setAiAppEnabled: vi.fn().mockRejectedValue(apiError(404, 'AI App not found')),
    });
    await expect(runAppSetEnabled(client, 'nope', true)).rejects.toThrow('AI App not found');
  });

  it('confirms the toggle', async () => {
    const client = stubClient({
      setAiAppEnabled: vi
        .fn()
        .mockResolvedValue({ entry: { appId: 'demo-app', version: '1.0.0', enabled: false } }),
    });
    await runAppSetEnabled(client, 'demo-app', false);
    expect(logged.join('\n')).toContain('Disabled demo-app@1.0.0');
  });
});

describe('parseParamFlags', () => {
  it('splits on the first equals sign', () => {
    expect(parseParamFlags(['language=Spanish', 'note=a=b'])).toEqual({
      language: 'Spanish',
      note: 'a=b',
    });
  });

  it('rejects a flag without a key', () => {
    expect(() => parseParamFlags(['=oops'])).toThrow(/expected key=value/);
    expect(() => parseParamFlags(['plain'])).toThrow(/expected key=value/);
  });
});

describe('runAppApply guards', () => {
  it('requires the app to be installed', async () => {
    const client = stubClient({ listAiApps: vi.fn().mockResolvedValue({ apps: [] }) });
    await expect(runAppApply(client, 'nope', dir, { yes: true })).rejects.toThrow(
      /not installed.*gezel app add/,
    );
  });

  it('requires the app to be enabled', async () => {
    const client = stubClient({
      listAiApps: vi.fn().mockResolvedValue({
        apps: [
          {
            appId: 'demo-app',
            version: '1.0.0',
            packageSha256: 'b'.repeat(64),
            installedAt: '2026-08-01T00:00:00.000Z',
            enabled: false,
            name: 'Demo App',
            description: '',
            publisher: null,
            itemCount: 1,
            dependencyCount: 0,
            versionsOnDisk: ['1.0.0'],
          },
        ],
      }),
    });
    await expect(runAppApply(client, 'demo-app', dir, { yes: true })).rejects.toThrow(
      /disabled.*gezel app enable/,
    );
  });

  it('no-ops when the same version is already applied (without --refresh)', async () => {
    const client = stubClient({
      listAiApps: vi.fn().mockResolvedValue({
        apps: [
          {
            appId: 'demo-app',
            version: '1.0.0',
            packageSha256: 'b'.repeat(64),
            installedAt: '2026-08-01T00:00:00.000Z',
            enabled: true,
            name: 'Demo App',
            description: '',
            publisher: null,
            itemCount: 1,
            dependencyCount: 0,
            versionsOnDisk: ['1.0.0'],
          },
        ],
      }),
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'p1', name: 'Demo', workingDir: dir }] }),
      getProject: vi.fn().mockResolvedValue({
        id: 'p1',
        name: 'Demo',
        workingDir: dir,
        projectType: { id: 'demo-app', version: '1.0.0', source: 'x', appliedAt: 'now' },
      }),
    });
    await runAppApply(client, 'demo-app', dir, { yes: true });
    expect(logged.join('\n')).toContain('already applied');
  });

  it('refuses to apply over a different app without --force', async () => {
    const client = stubClient({
      listAiApps: vi.fn().mockResolvedValue({
        apps: [
          {
            appId: 'demo-app',
            version: '1.0.0',
            packageSha256: 'b'.repeat(64),
            installedAt: '2026-08-01T00:00:00.000Z',
            enabled: true,
            name: 'Demo App',
            description: '',
            publisher: null,
            itemCount: 1,
            dependencyCount: 0,
            versionsOnDisk: ['1.0.0'],
          },
        ],
      }),
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'p1', name: 'Demo', workingDir: dir }] }),
      getProject: vi.fn().mockResolvedValue({
        id: 'p1',
        name: 'Demo',
        workingDir: dir,
        projectType: { id: 'other-app', version: '1.0.0', source: 'x', appliedAt: 'now' },
      }),
    });
    await expect(runAppApply(client, 'demo-app', dir, { yes: true })).rejects.toThrow(
      /already has "other-app" applied/,
    );
  });
});

describe('runAppStatus', () => {
  it('reports an unlinked folder without creating a project', async () => {
    const listProjects = vi.fn().mockResolvedValue({ projects: [] });
    const createProject = vi.fn();
    const client = stubClient({ listProjects, createProject });
    await runAppStatus(client, dir, {});
    expect(logged.join('\n')).toContain('No gezel project is linked');
    expect(createProject).not.toHaveBeenCalled();
  });

  it('reports the applied app, updates, and seed drift', async () => {
    const client = stubClient({
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'p1', name: 'Demo', workingDir: dir }] }),
      projectTypeStatus: vi.fn().mockResolvedValue({
        projectId: 'p1',
        provenance: {
          id: 'demo-app',
          version: '1.0.0',
          source: 'x',
          appliedAt: '2026-08-01T00:00:00.000Z',
        },
        installedApp: { appId: 'demo-app', version: '2.0.0', enabled: true },
        updateAvailable: true,
        seeds: [
          { path: 'data.json', state: 'ok' },
          { path: 'notes.md', state: 'modified' },
        ],
      }),
    });
    await runAppStatus(client, dir, {});
    const out = logged.join('\n');
    expect(out).toContain('demo-app 1.0.0');
    expect(out).toContain('installed 2.0.0');
    expect(out).toContain('Update available: gezel app apply demo-app');
    expect(out).toContain('1 ok, 1 modified');
    expect(out).toContain('notes.md — modified');
  });
});

describe('runAppServe verbs', () => {
  it('status lists sites or says none are serving', async () => {
    const client = stubClient({ listAppServeSites: vi.fn().mockResolvedValue({ sites: [] }) });
    await runAppServe(client, ['status'], dir, { allowHost: [] });
    expect(logged.join('\n')).toContain('No app sites are being served');
  });

  it('stop refuses an ambiguous target and honors --all', async () => {
    const sites = [
      {
        siteId: 's1',
        typeId: 'a',
        typeVersion: '1',
        url: 'u',
        projectName: 'P1',
        visitors: 0,
        chat: false,
      },
      {
        siteId: 's2',
        typeId: 'b',
        typeVersion: '1',
        url: 'u',
        projectName: 'P2',
        visitors: 0,
        chat: false,
      },
    ];
    const stopAppServeSite = vi.fn().mockResolvedValue({ ok: true });
    const client = stubClient({
      listAppServeSites: vi.fn().mockResolvedValue({ sites }),
      stopAppServeSite,
    });
    await expect(runAppServe(client, ['stop'], dir, { allowHost: [] })).rejects.toThrow(
      /several sites/,
    );
    await runAppServe(client, ['stop'], dir, { allowHost: [], all: true });
    expect(stopAppServeSite).toHaveBeenCalledTimes(2);
  });

  it('stop matches a site by app id', async () => {
    const stopAppServeSite = vi.fn().mockResolvedValue({ ok: true });
    const client = stubClient({
      listAppServeSites: vi.fn().mockResolvedValue({
        sites: [
          {
            siteId: 's1',
            typeId: 'demo-app',
            typeVersion: '1',
            url: 'u',
            projectName: 'P',
            visitors: 0,
            chat: false,
          },
        ],
      }),
      stopAppServeSite,
    });
    await runAppServe(client, ['stop', 'demo-app'], dir, { allowHost: [] });
    expect(stopAppServeSite).toHaveBeenCalledWith('s1');
  });

  it('serve start requires an applied app in the folder', async () => {
    const client = stubClient({
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'p1', name: 'X', workingDir: dir }] }),
      getProject: vi.fn().mockResolvedValue({ id: 'p1', name: 'X', workingDir: dir }),
    });
    await expect(runAppServe(client, [], dir, { allowHost: [] })).rejects.toThrow(
      /gezel app apply/,
    );
  });

  it('serve start with --detach prints the share link and returns', async () => {
    const client = stubClient({
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'p1', name: 'X', workingDir: dir }] }),
      getProject: vi.fn().mockResolvedValue({
        id: 'p1',
        name: 'X',
        workingDir: dir,
        projectType: { id: 'demo-app', version: '1.0.0', source: 'x', appliedAt: 'now' },
      }),
      startAppServe: vi.fn().mockResolvedValue({
        siteId: 's1',
        projectId: 'p1',
        projectName: 'X',
        typeId: 'demo-app',
        typeName: 'Demo App',
        typeVersion: '1.0.0',
        host: '127.0.0.1',
        port: 4242,
        url: 'http://127.0.0.1:4242/',
        chat: true,
        public: false,
        startedAt: 'now',
        visitors: 0,
        counters: { pageViews: 0, invokes: 0, reads: 0, chatMessages: 0 },
        siteKey: 'k'.repeat(24),
        shareUrl: `http://127.0.0.1:4242/?k=${'k'.repeat(24)}`,
      }),
    });
    await runAppServe(client, [], dir, { allowHost: [], chat: true, detach: true });
    const out = logged.join('\n');
    expect(out).toContain('Serving "Demo App"');
    expect(out).toContain('http://127.0.0.1:4242/?k=');
    expect(out).toContain('Chat: on');
    expect(out).toContain('Serving continues in the daemon');
  });
});
