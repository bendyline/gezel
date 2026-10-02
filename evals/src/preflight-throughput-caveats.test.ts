import { describe, expect, it } from 'vitest';
import { preflightThroughputCaveats } from './preflight.ts';

describe('preflightThroughputCaveats', () => {
  it('flags the 2026-09-29 probe: ~55 decode tokens an hour after boot', () => {
    const caveats = preflightThroughputCaveats({ genTokens: 55, uptimeSeconds: 3845 });
    expect(caveats).toHaveLength(2);
    expect(caveats[0]).toContain('55 decode tokens');
    expect(caveats[1]).toContain('host up 64 min');
  });

  it('stays silent for a substantial sample on a settled host', () => {
    expect(preflightThroughputCaveats({ genTokens: 400, uptimeSeconds: 86_400 })).toEqual([]);
  });

  it('does not invent caveats when the engine log or uptime is unavailable', () => {
    expect(preflightThroughputCaveats({ genTokens: null })).toEqual([]);
  });
});
