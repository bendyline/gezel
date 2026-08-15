import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertServiceBuildFresh,
  inspectServiceBuildFreshness,
} from './service-build-freshness.ts';

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
  const root = fixtureDir('eval-service-freshness-');
  const daemonEntry = join(root, 'dist', 'bin', 'gezeld.js');
  const source = join(root, 'src', 'index.ts');
  mkdirSync(join(root, 'dist', 'bin'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(daemonEntry, 'built');
  writeFileSync(source, 'source');
  return { daemonEntry, source };
}

describe('service build freshness', () => {
  it('accepts a build newer than its workspace source', () => {
    const { daemonEntry, source } = serviceFixture();
    utimesSync(source, new Date(1_000), new Date(1_000));
    utimesSync(daemonEntry, new Date(2_000), new Date(2_000));
    expect(inspectServiceBuildFreshness(daemonEntry).fresh).toBe(true);
    expect(() => assertServiceBuildFresh(daemonEntry)).not.toThrow();
  });

  it('rejects source changes newer than the daemon bundle with an actionable command', () => {
    const { daemonEntry, source } = serviceFixture();
    utimesSync(daemonEntry, new Date(1_000), new Date(1_000));
    utimesSync(source, new Date(2_000), new Date(2_000));
    expect(inspectServiceBuildFreshness(daemonEntry).fresh).toBe(false);
    expect(() => assertServiceBuildFresh(daemonEntry)).toThrow(
      /eval service build is stale.*pnpm --filter @bendyline\/gezel-service build/s,
    );
  });

  it('does not impose a workspace check on a published dist-only package', () => {
    const root = fixtureDir('eval-service-published-');
    const daemonEntry = join(root, 'dist', 'bin', 'gezeld.js');
    mkdirSync(join(root, 'dist', 'bin'), { recursive: true });
    writeFileSync(daemonEntry, 'built');
    expect(inspectServiceBuildFreshness(daemonEntry)).toEqual({ fresh: true, daemonEntry });
  });

  it('ignores test-only source edits that are not bundled into the daemon', () => {
    const { daemonEntry, source } = serviceFixture();
    const testSource = join(dirname(source), 'manager.test.ts');
    writeFileSync(testSource, 'new test');
    utimesSync(source, new Date(1_000), new Date(1_000));
    utimesSync(daemonEntry, new Date(2_000), new Date(2_000));
    utimesSync(testSource, new Date(3_000), new Date(3_000));
    expect(inspectServiceBuildFreshness(daemonEntry).fresh).toBe(true);
  });
});
