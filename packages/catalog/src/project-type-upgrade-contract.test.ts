/**
 * Projects move to newer versions of their app (project type) within a major
 * version on their own (service `project-type/upgrade.ts`). That is safe only
 * if every version of a major reads the data an earlier one wrote, and if a
 * param added later has a default to render with. These checks hold the
 * pinned Gilde content to both rules for every pair of versions in a major:
 * - a seed file's top-level `"version"` format stamp never changes (stores
 *   refuse a stamp they do not know, and nothing migrates app data);
 * - a param a later version adds carries a `default`.
 * A violation is fixed in Gilde (a new major, or a default), never by
 * loosening this test.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compareSemver, isSemver } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';

interface VersionManifest {
  version: string;
  params?: { properties?: Record<string, { default?: unknown } | undefined> };
  workspaceSeed?: string[];
  artifactsSeed?: string[];
}

async function projectTypeDirs(): Promise<string[]> {
  const root = join(gildeDataDir(), 'project-types');
  const dirs: string[] = [];
  for (const shard of await readdir(root, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const item of await readdir(join(root, shard.name), { withFileTypes: true })) {
      if (item.isDirectory()) dirs.push(join(root, shard.name, item.name));
    }
  }
  return dirs;
}

async function versions(typeDir: string): Promise<VersionManifest[]> {
  const names = (await readdir(join(typeDir, 'versions')).catch(() => [])).filter(isSemver);
  const out: VersionManifest[] = [];
  for (const name of names.sort(compareSemver)) {
    try {
      out.push(
        JSON.parse(await readFile(join(typeDir, 'versions', name, 'manifest.json'), 'utf8')),
      );
    } catch {
      // A version folder without a readable manifest is the catalog's own test's to report.
    }
  }
  return out;
}

async function seedStamp(typeDir: string, version: string, rel: string): Promise<unknown> {
  try {
    const parsed = JSON.parse(await readFile(join(typeDir, 'versions', version, rel), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { version?: unknown }).version
      : undefined;
  } catch {
    return undefined;
  }
}

const major = (version: string) => version.split('.', 1)[0];

describe('project type versions are safe to update to', () => {
  it('keeps seed format stamps and gives added params a default within a major', async () => {
    const problems: string[] = [];
    let pairs = 0;
    for (const typeDir of await projectTypeDirs()) {
      const id = typeDir.split(/[\\/]/).at(-1)!;
      const all = await versions(typeDir);
      for (let i = 1; i < all.length; i++) {
        const before = all[i - 1]!;
        const after = all[i]!;
        if (major(before.version) !== major(after.version)) continue;
        pairs += 1;

        const beforeParams = before.params?.properties ?? {};
        for (const [key, schema] of Object.entries(after.params?.properties ?? {})) {
          if (!(key in beforeParams) && schema?.default === undefined) {
            problems.push(`${id} ${after.version}: param "${key}" added without a default`);
          }
        }

        const seeds = (m: VersionManifest) => [
          ...(m.workspaceSeed ?? []),
          ...(m.artifactsSeed ?? []),
        ];
        const shared = seeds(after).filter((rel) => seeds(before).includes(rel));
        for (const rel of shared) {
          const was = await seedStamp(typeDir, before.version, rel);
          const now = await seedStamp(typeDir, after.version, rel);
          if (was !== now) {
            problems.push(
              `${id} ${before.version} -> ${after.version}: ${rel} format stamp ${String(was)} -> ${String(now)}`,
            );
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
