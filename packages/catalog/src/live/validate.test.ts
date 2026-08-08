import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateGildeContentUpgrade } from './validate.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-gilde-validate-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeToolset(dataDir: string, id: string, opts: { broken?: boolean } = {}) {
  const dir = join(dataDir, 'toolsets', id.slice(0, 2), id);
  await mkdir(join(dir, 'versions', '1.0.0'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'toolset',
      id,
      name: id,
      description: `${id} fixture`,
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    }),
  );
  const version = opts.broken
    ? '{ not json'
    : JSON.stringify({
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: '2026-04-22T00:00:00Z',
        runtime: { kind: 'http-mcp', url: 'https://example.com/mcp' },
        tools: [],
        config: [],
      });
  await writeFile(join(dir, 'versions', '1.0.0', 'manifest.json'), version);
}

async function makeDataDir(name: string): Promise<string> {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('validateGildeContentUpgrade', () => {
  it('passes when every current item still resolves in the candidate', async () => {
    const current = await makeDataDir('current');
    const candidate = await makeDataDir('candidate');
    await writeToolset(current, 'aa-tool');
    await writeToolset(candidate, 'aa-tool');
    await writeToolset(candidate, 'bb-new');
    const result = await validateGildeContentUpgrade({
      currentDataDir: current,
      candidateDataDir: candidate,
    });
    expect(result).toEqual({ ok: true, checked: 1 });
  });

  it('flags an item the candidate no longer carries', async () => {
    const current = await makeDataDir('current');
    const candidate = await makeDataDir('candidate');
    await writeToolset(current, 'aa-tool');
    await writeToolset(current, 'bb-tool');
    await writeToolset(candidate, 'aa-tool');
    const result = await validateGildeContentUpgrade({
      currentDataDir: current,
      candidateDataDir: candidate,
    });
    expect(result).toEqual({ ok: false, regressions: [{ kind: 'toolset', id: 'bb-tool' }] });
  });

  it('flags an item whose candidate version manifest no longer parses', async () => {
    const current = await makeDataDir('current');
    const candidate = await makeDataDir('candidate');
    await writeToolset(current, 'aa-tool');
    await writeToolset(candidate, 'aa-tool', { broken: true });
    const result = await validateGildeContentUpgrade({
      currentDataDir: current,
      candidateDataDir: candidate,
    });
    expect(result).toEqual({ ok: false, regressions: [{ kind: 'toolset', id: 'aa-tool' }] });
  });

  it('ignores a candidate-only item that fails to parse (new content, newer schemas)', async () => {
    const current = await makeDataDir('current');
    const candidate = await makeDataDir('candidate');
    await writeToolset(current, 'aa-tool');
    await writeToolset(candidate, 'aa-tool');
    await writeToolset(candidate, 'zz-future', { broken: true });
    const result = await validateGildeContentUpgrade({
      currentDataDir: current,
      candidateDataDir: candidate,
    });
    expect(result).toEqual({ ok: true, checked: 1 });
  });

  it('covers the community tier', async () => {
    const current = await makeDataDir('current');
    const candidate = await makeDataDir('candidate');
    await writeToolset(current, 'aa-tool');
    await writeToolset(join(current, 'community'), 'cc-community');
    await writeToolset(candidate, 'aa-tool');
    const result = await validateGildeContentUpgrade({
      currentDataDir: current,
      candidateDataDir: candidate,
    });
    expect(result).toEqual({
      ok: false,
      regressions: [{ kind: 'toolset', id: 'cc-community' }],
    });
  });

  it('honors bundled-over-community shadowing on both sides', async () => {
    const current = await makeDataDir('current');
    const candidate = await makeDataDir('candidate');
    await writeToolset(current, 'aa-tool');
    await writeToolset(join(current, 'community'), 'aa-tool');
    // Candidate drops the community duplicate but keeps the bundled item —
    // nothing user-visible regressed.
    await writeToolset(candidate, 'aa-tool');
    const result = await validateGildeContentUpgrade({
      currentDataDir: current,
      candidateDataDir: candidate,
    });
    expect(result).toEqual({ ok: true, checked: 1 });
  });
});
