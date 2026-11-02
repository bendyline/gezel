import { describe, expect, it } from 'vitest';
import { applyFirstBootSeeds } from './boot-seeds.js';

function store() {
  const writes: Array<Record<string, unknown>> = [];
  return { writes, writeConfig: async (patch: Record<string, unknown>) => void writes.push(patch) };
}

describe('applyFirstBootSeeds', () => {
  it('applies the deployer settings to a home this boot created', async () => {
    const s = store();
    const result = await applyFirstBootSeeds(
      s as never,
      { GEZEL_INITIAL_SECURITY_LEVEL: 'super-lockdown', GEZEL_INITIAL_MODE: 'reactive+tasks' },
      true,
    );
    expect(result).toEqual({ securityLevel: 'super-lockdown', mode: 'scheduled', ignored: [] });
    expect(s.writes[0]).toMatchObject({ securityPolicy: { level: 'super-lockdown' } });
    expect(s.writes[1]).toEqual({ aiEngagementMode: 'scheduled' });
  });

  it('leaves an existing home alone', async () => {
    const s = store();
    await applyFirstBootSeeds(s as never, { GEZEL_INITIAL_SECURITY_LEVEL: 'free' }, false);
    expect(s.writes).toEqual([]);
  });

  it('ignores values it does not know rather than guessing', async () => {
    const s = store();
    const result = await applyFirstBootSeeds(
      s as never,
      { GEZEL_INITIAL_SECURITY_LEVEL: 'custom', GEZEL_INITIAL_MODE: 'turbo' },
      true,
    );
    expect(result.ignored).toEqual([
      'GEZEL_INITIAL_SECURITY_LEVEL=custom',
      'GEZEL_INITIAL_MODE=turbo',
    ]);
    expect(s.writes).toEqual([]);
  });
});
