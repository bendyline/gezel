/**
 * The plain-English role titles must not capture a role the catalog already
 * uses with another meaning. Every predicate reads an English title as its
 * Dutch key (`roleForMatching`), so if a book's worker were already called
 * "Office manager", renaming the Kantoormeester to that would quietly hand
 * the worker the Kantoormeester's kit. So while the catalog still uses a
 * Dutch title, any use of its English replacement must already mean the same
 * role. Once the catalog itself has moved to the English title, its uses are
 * the rename, and there is nothing left to collide with.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROLES,
  ROLE_ALIASES,
  type RoleId,
  isLegacyRoleTitle,
  legacyRoleKey,
  resolveRoleId,
} from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';

/** `resolveRoleId` as it reads a title that is not mapped to a renamed one. */
function resolveWithoutRenames(role: string): RoleId | null {
  const key = role.toLowerCase().trim();
  if (key in ROLES) return key as RoleId;
  const matches = (alias: (typeof ROLE_ALIASES)[number]) =>
    alias.wholeWord
      ? new RegExp(String.raw`(?<![\p{L}\p{N}])${alias.contains}(?![\p{L}\p{N}])`, 'u').test(key)
      : key.includes(alias.contains);
  return ROLE_ALIASES.find(matches)?.canonical ?? null;
}

async function catalogRoles(): Promise<Set<string>> {
  const roles = new Set<string>();
  for (const kind of ['gezel-templates', 'craftbook-templates', 'project-types']) {
    const text = await readFile(join(gildeDataDir(), kind, 'index.json'), 'utf8').catch(() => '');
    for (const match of text.matchAll(/"(?:suggestedRole|role)":"([^"]+)"/g)) roles.add(match[1]!);
  }
  return roles;
}

describe('plain role titles against the catalog', () => {
  it('never rename a role into one the catalog already uses differently', async () => {
    const roles = await catalogRoles();
    expect(roles.size).toBeGreaterThan(0);
    const stillDutch = new Set(
      [...roles].filter((role) => isLegacyRoleTitle(role)).map((role) => legacyRoleKey(role)),
    );
    for (const role of roles) {
      const legacy = legacyRoleKey(role);
      if (!legacy || isLegacyRoleTitle(role) || !stillDutch.has(legacy)) continue;
      expect(resolveWithoutRenames(role), role).toBe(resolveRoleId(legacy));
    }
  });
});
