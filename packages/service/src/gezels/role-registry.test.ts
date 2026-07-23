import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { KNOWN_PROFILE_IDS, ROLES, type RoleId } from '@bendyline/gezel';
import { BUILTIN_TOOLSETS, gildeDataDir } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import { listStdlibScripts } from '../scripts/stdlib-source.js';

/**
 * The role registry (packages/core/src/roles) declares each role's bundle:
 * toolset kit, tuning profile, gate vocabulary, default books, capability
 * floor. Those fields name real things in OTHER packages — this test
 * enforces that the references resolve so a renamed toolset group, a
 * retired craftbook, a typo'd check, or an unknown profile id is caught
 * here rather than as a silently-empty kit at runtime.
 */

const roleIds = Object.keys(ROLES) as RoleId[];

describe('role registry cross-references', () => {
  it('every toolsetGroups id is a real builtin toolset group', () => {
    const builtin = new Set(BUILTIN_TOOLSETS.map((g) => g.id));
    for (const id of roleIds) {
      for (const group of ROLES[id].toolsetGroups) {
        expect(builtin.has(group), `${id}: unknown toolset group "${group}"`).toBe(true);
      }
    }
  });

  it('every suggestedTuningProfile is a known profile id', () => {
    const profiles = new Set<string>(KNOWN_PROFILE_IDS);
    for (const id of roleIds) {
      const p = ROLES[id].suggestedTuningProfile;
      if (p === undefined) continue;
      expect(profiles.has(p), `${id}: unknown tuning profile "${p}"`).toBe(true);
    }
  });

  it('every gateAffinity script is a real standard stdlib script', async () => {
    const stdlib = new Set((await listStdlibScripts()).map((s) => s.name));
    let refs = 0;
    for (const id of roleIds) {
      for (const ref of ROLES[id].gateAffinity) {
        refs++;
        expect(stdlib.has(ref.name), `${id}: gateAffinity names unknown script "${ref.name}"`).toBe(
          true,
        );
      }
    }
    // Guard against the set silently emptying (e.g. all affinities dropped).
    expect(refs).toBeGreaterThan(0);
  });

  it('every defaultBooks id names a real craftbook template', async () => {
    const templatesDir = join(gildeDataDir(), 'craftbook-templates');
    const bookIds = new Set<string>();
    const shards = await readdir(templatesDir);
    for (const shard of shards) {
      if (shard.startsWith('.') || shard.endsWith('.json')) continue;
      let books: string[];
      try {
        books = await readdir(join(templatesDir, shard));
      } catch {
        continue;
      }
      for (const book of books) {
        if (!book.startsWith('.')) bookIds.add(book);
      }
    }
    // Sanity: the templates dir resolved and is populated.
    expect(bookIds.size).toBeGreaterThan(100);
    for (const id of roleIds) {
      for (const book of ROLES[id].defaultBooks) {
        expect(bookIds.has(book), `${id}: defaultBooks names unknown craftbook "${book}"`).toBe(
          true,
        );
      }
    }
  });
});
