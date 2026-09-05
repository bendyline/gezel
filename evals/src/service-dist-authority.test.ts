import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertServiceDistArtifact, inspectServiceDistArtifact } from './service-dist-authority.ts';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixtureDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(path);
  return path;
}

function serviceFixture(): { daemonEntry: string; source: string } {
  const root = fixtureDir('eval-service-dist-authority-');
  const daemonEntry = join(root, 'dist', 'bin', 'gezeld.js');
  const source = join(root, 'src', 'index.ts');
  mkdirSync(join(root, 'dist', 'bin'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(daemonEntry, 'compiled subject');
  writeFileSync(source, 'source');
  return { daemonEntry, source };
}

describe('service dist authority', () => {
  it('ignores source changes newer than the compiled eval subject', () => {
    const { daemonEntry, source } = serviceFixture();
    utimesSync(daemonEntry, new Date(1_000), new Date(1_000));

    const before = inspectServiceDistArtifact(daemonEntry);
    utimesSync(source, new Date(2_000), new Date(2_000));

    expect(inspectServiceDistArtifact(daemonEntry)).toEqual(before);
    expect(() => assertServiceDistArtifact(daemonEntry)).not.toThrow();
  });

  it('identifies the selected dist artifact itself', () => {
    const { daemonEntry } = serviceFixture();
    utimesSync(daemonEntry, new Date(2_000), new Date(2_000));

    expect(inspectServiceDistArtifact(daemonEntry)).toEqual({
      daemonEntry,
      size: Buffer.byteLength('compiled subject'),
      mtimeMs: 2_000,
    });
  });

  it('rejects an unavailable dist artifact with an actionable build command', () => {
    const missing = join(fixtureDir('eval-service-dist-missing-'), 'dist', 'bin', 'gezeld.js');

    expect(() => assertServiceDistArtifact(missing)).toThrow(
      /eval service dist artifact is unavailable.*pnpm --filter @bendyline\/gezel-service build/s,
    );
  });
});
