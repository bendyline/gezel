import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstalledToolset } from '@bendyline/gezel';
import { projectToolsetsFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

let home: string;
let store: Store;

const toolset = (id: string): InstalledToolset => ({
  toolsetId: id,
  sourceId: 'bundled',
  version: '1.0.0',
  installedAt: '2026-07-06T00:00:00Z',
  runtime: {
    kind: 'http-mcp',
    url: 'https://example.com/mcp',
    transport: 'streamable-http',
    authHint: 'none',
    envHints: [],
  },
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'proj-toolset-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('project toolset scope', () => {
  it('round-trips project-scope toolsets independently of other scopes', async () => {
    await store.writeInstalledToolsets({ kind: 'project', projectId: 'learn-spanish' }, [
      toolset('web-search'),
    ]);
    await store.writeInstalledToolsets({ kind: 'gezel', gezelId: 'g1' }, [toolset('github')]);

    const proj = await store.listInstalledToolsets({ kind: 'project', projectId: 'learn-spanish' });
    expect(proj.map((t) => t.toolsetId)).toEqual(['web-search']);

    // Isolation: a different project, the gezel scope, and shared scope don't
    // see this project's toolset.
    expect(await store.listInstalledToolsets({ kind: 'project', projectId: 'other' })).toEqual([]);
    expect(
      (await store.listInstalledToolsets({ kind: 'gezel', gezelId: 'g1' })).map((t) => t.toolsetId),
    ).toEqual(['github']);
    expect(await store.listInstalledToolsets({ kind: 'shared' })).toEqual([]);
  });

  it('writes the project toolsets file under the project-local dir', async () => {
    await store.writeInstalledToolsets({ kind: 'project', projectId: 'learn-spanish' }, [
      toolset('web-search'),
    ]);
    expect(existsSync(projectToolsetsFile(home, 'learn-spanish'))).toBe(true);
  });

  it('resolves distinct install roots per scope', () => {
    const projectRoot = store.toolsetInstallRoot({ kind: 'project', projectId: 'p1' });
    const gezelRoot = store.toolsetInstallRoot({ kind: 'gezel', gezelId: 'g1' });
    const sharedRoot = store.toolsetInstallRoot({ kind: 'shared' });
    expect(projectRoot).toContain(join('projects', 'p1'));
    expect(projectRoot).not.toBe(gezelRoot);
    expect(projectRoot).not.toBe(sharedRoot);
  });
});
