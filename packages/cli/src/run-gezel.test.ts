import type { GezelSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { CliError } from './connection.js';
import { resolveRunGezel } from './run-gezel.js';

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
