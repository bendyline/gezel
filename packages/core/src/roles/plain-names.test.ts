import { describe, expect, it } from 'vitest';
import { isBackgroundServiceRole } from '../app-subject.js';
import { roleTokens } from '../gezels/match.js';
import {
  isLegacyRoleTitle,
  legacyRoleKey,
  legacyRoleTitles,
  plainRoleProse,
  plainRoleTitle,
  roleForMatching,
  roleWithGloss,
} from './plain-names.js';
import { ROLES, resolveRoleId, toolsetGroupsForRole } from './registry.js';

const pairs = Object.entries(legacyRoleTitles());

describe('plain role titles', () => {
  it('names a Dutch title in plain English, and leaves every other role alone', () => {
    expect(plainRoleTitle('Voorman')).toBe('Crew Lead');
    expect(plainRoleTitle('Boekwachter')).toBe('Librarian');
    expect(plainRoleTitle('Klerk')).toBe('Scribe');
    expect(plainRoleTitle('Keurmeester')).toBe('Inspector');
    expect(plainRoleTitle('  Zorgcoördinator ')).toBe('Care Coordinator');
    expect(plainRoleTitle('Researcher')).toBe('Researcher');
    expect(plainRoleTitle('Senior Voorman')).toBe('Senior Voorman');
    expect(plainRoleTitle('Meester')).toBe('Meester');
    expect(roleWithGloss('Reisleider')).toBe('Trip Planner');
  });

  it('reads either title as the same Dutch key, and only an exact title', () => {
    expect(legacyRoleKey('Crew Lead')).toBe('voorman');
    expect(legacyRoleKey('voorman')).toBe('voorman');
    expect(legacyRoleKey('  librarian ')).toBe('boekwachter');
    expect(legacyRoleKey('Head Librarian')).toBeUndefined();
    expect(legacyRoleKey(undefined)).toBeUndefined();
    expect(roleForMatching('Developer')).toBe('Developer');
    expect(isLegacyRoleTitle('Voorman')).toBe(true);
    expect(isLegacyRoleTitle('Crew Lead')).toBe(false);
  });

  it('rewrites only a gezel’s own Dutch title in its prose, keeping case and a/an', () => {
    expect(plainRoleProse('You are a **voorman**: the foreman.', 'Crew Lead')).toBe(
      'You are a **crew lead**: the foreman.',
    );
    expect(plainRoleProse('# Boekwachter\n\nThe boekwachter reads.', 'Boekwachter')).toBe(
      '# Librarian\n\nThe librarian reads.',
    );
    expect(plainRoleProse('You are a kantoormeester — the office.', 'Office Administrator')).toBe(
      'You are an office administrator — the office.',
    );
    expect(plainRoleProse('A Zorgcoördinator keeps notes.', 'Care Coordinator')).toBe(
      'A Care Coordinator keeps notes.',
    );
    expect(plainRoleProse('Ask the voorman, then the Meester.', 'Librarian')).toBe(
      'Ask the voorman, then the Meester.',
    );
    expect(plainRoleProse('voormannen and boekwachters', 'Crew Lead')).toBe(
      'voormannen and boekwachters',
    );
    expect(plainRoleProse('You are a planner.', 'Planner')).toBe('You are a planner.');
  });

  it('keeps the Meester, the one Dutch title', () => {
    expect(isLegacyRoleTitle('Meester')).toBe(false);
    expect(ROLES.meester.label).toBe('Meester');
    expect(ROLES.voorman.label).toBe('Crew Lead');
  });

  it('gives every English title a role of its own', () => {
    const titles = pairs.map(([, plain]) => plain.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
    for (const title of titles) {
      expect(title in ROLES, title).toBe(false);
      expect(legacyRoleKey(title) && title in legacyRoleTitles(), title).toBeFalsy();
    }
  });

  // The invariant the rename rests on: a gezel's tools, how it is matched to
  // work, and how it is classified never change with the words for its role.
  it.each(pairs)('%s and %s are the same role to every predicate', (legacy, plain) => {
    const dutch = legacy[0]!.toUpperCase() + legacy.slice(1);
    expect(resolveRoleId(plain)).toBe(resolveRoleId(dutch));
    expect(toolsetGroupsForRole(plain)).toEqual(toolsetGroupsForRole(dutch));
    expect([...roleTokens(plain)]).toEqual([...roleTokens(dutch)]);
    expect(isBackgroundServiceRole(plain)).toBe(isBackgroundServiceRole(dutch));
  });

  it('keeps the kits the old titles had', () => {
    expect(resolveRoleId('Crew Lead')).toBe('voorman');
    expect(resolveRoleId('Inspector')).toBe('meester');
    expect(resolveRoleId('Trip Planner')).toBeNull();
    expect(resolveRoleId('Character Artist')).toBe('designer');
    expect(isBackgroundServiceRole('Librarian')).toBe(true);
    expect(isBackgroundServiceRole('Scribe')).toBe(true);
    expect(isBackgroundServiceRole('Inspector')).toBe(true);
  });
});
