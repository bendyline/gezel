import { describe, expect, it } from 'vitest';
import { parseSeedDecisions } from './ab-band-prefix.ts';

/**
 * The `[batch] seed` line is the only place the MLX engine states what it
 * actually did with the cache, so this parser is the whole measurement. Its
 * vocabulary is the sidecar's, not llama's — see `ab-prefix-cache.ts` for the
 * llama-cpp equivalent.
 */
describe('parseSeedDecisions', () => {
  const LOG = `
2026-08-30T13:51:41.501Z INFO  [chat] [mlx] [cache] band-boundary chars=13177 target=36576 prompt_tokens=39446
2026-08-30T13:51:41.501Z INFO  [chat] [mlx] [batch] seed cache_id=ad209603-2264-44b8-890a-b35f403da9b8 mode=fresh reused=0 prefill=39446
2026-08-30T13:53:16.982Z INFO  [chat] [mlx] [cache] prefix-seeded prefix-band-dd0e075cb2034d8c from cache_id=ad209603 tokens=36576
2026-08-30T13:53:16.990Z INFO  [chat] [mlx] [batch] seed cache_id=403a07c8-e646-4d38-a64a-92e3942ac3da mode=extension reused=36576 prefill=2867
`;

  it('reads each seed decision off the engine log', () => {
    const seeds = parseSeedDecisions(LOG);
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toMatchObject({ mode: 'fresh', reused: 0, prefill: 39446 });
    expect(seeds[1]).toMatchObject({ mode: 'extension', reused: 36576, prefill: 2867 });
  });

  it('distinguishes the failure mode from a plain miss', () => {
    // `fresh-untrimmable` is not a miss — it means an entry was found and was
    // LONGER than the shared head, so the whole prompt was re-prefilled. A
    // parser that collapsed it into `fresh` would hide the one outcome this
    // work exists to prevent.
    const seeds = parseSeedDecisions(
      '[batch] seed cache_id=x mode=fresh-untrimmable reused=0 prefill=62915',
    );
    expect(seeds[0]?.mode).toBe('fresh-untrimmable');
  });

  it('returns nothing for a log with no seed lines', () => {
    expect(parseSeedDecisions('nothing to see')).toEqual([]);
  });
});
