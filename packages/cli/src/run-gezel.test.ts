import type { GezelSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { CliError } from './connection.js';
import { resolveCrewMember, resolveRunGezel } from './run-gezel.js';

function gezel(partial: Partial<GezelSummary> & { id: string; name: string }): GezelSummary {
  return partial as GezelSummary;
}

function client(gezels: GezelSummary[]) {
  return { listGezels: async () => ({ gezels }) } as never;
}

const CREW = [
  gezel({ id: 'ship-tester', name: 'Ship Tester' }),
  gezel({ id: 'joris', name: 'Joris', role: 'Builder' }),
  gezel({ id: 'yujin', name: 'Yujin', role: 'Builder' }),
  gezel({ id: 'yujin-2', name: 'Yujin', role: 'Boekwachter' }),
  gezel({ id: 'reinout', name: 'Reinout', role: 'Reviewer' }),
  gezel({ id: 'reina', name: 'Reina', role: 'Researcher' }),
];

describe('resolveRunGezel', () => {
  it('accepts an id', async () => {
    await expect(resolveRunGezel(client(CREW), 'ship-tester')).resolves.toBe('ship-tester');
  });

  it('resolves a display name with spaces, case-insensitively', async () => {
    await expect(resolveRunGezel(client(CREW), 'ship TESTER')).resolves.toBe('ship-tester');
  });

  it('resolves a role', async () => {
    await expect(resolveRunGezel(client(CREW), 'reviewer')).resolves.toBe('reinout');
  });

  it('lets an exact id win over a name two gezels share', async () => {
    await expect(resolveRunGezel(client(CREW), 'yujin')).resolves.toBe('yujin');
    await expect(resolveRunGezel(client(CREW), 'yujin-2')).resolves.toBe('yujin-2');
  });

  it('refuses to guess between two gezels with the same name', async () => {
    const result = resolveRunGezel(client(CREW), 'Yujin');
    await expect(result).rejects.toBeInstanceOf(CliError);
    await expect(result).rejects.toThrow('Yujin (yujin), Yujin (yujin-2)');
  });

  it('names the candidates of an ambiguous prefix', async () => {
    await expect(resolveRunGezel(client(CREW), 'rei')).rejects.toThrow(
      'Reinout (reinout), Reina (reina)',
    );
  });

  it('points at `gezel agent list` when nothing matches', async () => {
    await expect(resolveRunGezel(client(CREW), 'Astronaut')).rejects.toThrow('gezel agent list');
  });
});

describe('resolveCrewMember', () => {
  const crew = [...CREW, gezel({ id: 'rosa-writer', name: 'Rosa Writer', role: 'Writer' })];

  it('takes an exact id first, then a name in any case', async () => {
    await expect(resolveCrewMember(client(crew), 'rosa-writer')).resolves.toBe('rosa-writer');
    await expect(resolveCrewMember(client(crew), 'Rosa Writer')).resolves.toBe('rosa-writer');
    await expect(resolveCrewMember(client(crew), '  rosa writer ')).resolves.toBe('rosa-writer');
    await expect(resolveCrewMember(client(crew), 'yujin')).resolves.toBe('yujin');
  });

  it('lists every crew member that shares the name', async () => {
    await expect(resolveCrewMember(client(crew), 'YUJIN')).rejects.toThrow(
      '"YUJIN" matches more than one crew member: Yujin (yujin), Yujin (yujin-2). Pass the id instead.',
    );
  });

  it('matches neither a role nor a prefix', async () => {
    for (const ref of ['reviewer', 'rosa', 'Rosa W']) {
      const result = resolveCrewMember(client(crew), ref);
      await expect(result).rejects.toBeInstanceOf(CliError);
      await expect(result).rejects.toThrow('gezel agent list');
    }
  });
});
