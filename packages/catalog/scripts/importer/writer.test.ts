import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolsetIdentity, ToolsetVersionManifest } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from './fs-utils.js';
import { writeToolset } from './writer.js';

const FAKE_SHA = 'a'.repeat(64);
const FAKE_SHA_2 = 'b'.repeat(64);

function identity(overrides: Partial<ToolsetIdentity> = {}): ToolsetIdentity {
  return {
    schemaVersion: 1,
    kind: 'toolset',
    id: 'acme-widget',
    name: 'Widget',
    description: 'A useful widget.',
    tags: [],
    maintainer: { name: 'acme' },
    license: 'MIT',
    yankedVersions: [],
    ...overrides,
  };
}

function version(overrides: Partial<ToolsetVersionManifest> = {}): ToolsetVersionManifest {
  return {
    schemaVersion: 1,
    version: '1.2.3',
    releasedAt: '2026-04-30T12:00:00Z',
    runtime: {
      kind: 'npm-package',
      package: '@acme/widget',
      version: '1.2.3',
      sha256: FAKE_SHA,
      entry: 'dist/index.js',
      args: [],
      envHints: [],
    },
    tools: [],
    config: [],
    ...overrides,
  };
}

describe('writeToolset', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-writer-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a fresh entry on first write', async () => {
    const out = await writeToolset(identity(), version(), { root });
    expect(out.kind).toBe('created');
    const idRaw = await readFile(out.identityPath, 'utf8');
    const verRaw = await readFile(out.versionPath, 'utf8');
    expect(JSON.parse(idRaw).id).toBe('acme-widget');
    expect(JSON.parse(verRaw).version).toBe('1.2.3');
  });

  it('shards by first two chars of id', async () => {
    const out = await writeToolset(identity(), version(), { root });
    expect(out.identityPath).toContain(join('toolsets', 'ac', 'acme-widget'));
  });

  it('preserves editorial fields and unions yankedVersions on re-import', async () => {
    // Pre-seed an existing identity manifest with a hand-edited name.
    const itemDir = join(root, 'toolsets', 'ac', 'acme-widget');
    await writeJsonAtomic(
      join(itemDir, 'manifest.json'),
      identity({ name: 'Widget (Curated)', tags: ['handpicked'], yankedVersions: ['0.9.0'] }),
    );
    const out = await writeToolset(identity({ yankedVersions: ['1.2.3'] }), version(), { root });
    expect(out.kind).toBe('updated');
    const merged = JSON.parse(await readFile(out.identityPath, 'utf8'));
    expect(merged.name).toBe('Widget (Curated)');
    expect(merged.tags).toEqual(['handpicked']);
    expect(merged.yankedVersions.sort()).toEqual(['0.9.0', '1.2.3']);
  });

  it('returns noop when nothing changed', async () => {
    await writeToolset(identity(), version(), { root });
    const out = await writeToolset(identity(), version(), { root });
    expect(out.kind).toBe('noop');
  });

  it('refuses to overwrite a version when its npm sha256 changes', async () => {
    await writeToolset(identity(), version(), { root });
    const next = version({
      runtime: {
        kind: 'npm-package',
        package: '@acme/widget',
        version: '1.2.3',
        sha256: FAKE_SHA_2,
        entry: 'dist/index.js',
        args: [],
        envHints: [],
      },
    });
    const out = await writeToolset(identity(), next, { root });
    expect(out.kind).toBe('integrity-violation');
    if (out.kind === 'integrity-violation') {
      expect(out.detail).toContain('sha256');
    }
    // Confirm the on-disk file is unchanged.
    const stored = JSON.parse(await readFile(out.versionPath, 'utf8'));
    expect(stored.runtime.sha256).toBe(FAKE_SHA);
  });

  it('dryRun computes an outcome without writing', async () => {
    const out = await writeToolset(identity(), version(), { root, dryRun: true });
    expect(out.kind).toBe('created');
    await expect(readFile(out.identityPath, 'utf8')).rejects.toBeTruthy();
  });
});
