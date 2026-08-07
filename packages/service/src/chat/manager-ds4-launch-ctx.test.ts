import { describe, expect, it } from 'vitest';
import { resolveDs4LaunchCtx } from './manager.js';

/**
 * The RAM tier is calibrated on DeepSeek V4 Flash, which keeps only ~4 GiB of
 * non-routed weights resident. GLM 5.2 IQ2_XXS keeps 19.6 GiB and spends
 * 89 KiB/token on MLA KV, so its catalog entry lowers the window. A model may
 * only ever lower the tier — never raise it past what the device can hold.
 */
describe('resolveDs4LaunchCtx', () => {
  it('uses the device tier when the catalog sets no cap', () => {
    expect(resolveDs4LaunchCtx({ ramTieredCtx: 131_072 })).toBe(131_072);
  });

  it('lowers the tier to the catalog cap', () => {
    expect(resolveDs4LaunchCtx({ ramTieredCtx: 131_072, catalogMaxCtx: 65_536 })).toBe(65_536);
  });

  it('never raises the device tier, even when the catalog asks for more', () => {
    expect(resolveDs4LaunchCtx({ ramTieredCtx: 131_072, catalogMaxCtx: 1_048_576 })).toBe(131_072);
  });

  it('honors an explicit config override over both', () => {
    expect(
      resolveDs4LaunchCtx({ configured: 262_144, ramTieredCtx: 131_072, catalogMaxCtx: 65_536 }),
    ).toBe(262_144);
  });

  it('does not let an explicit limit push a long-context model below 64K', () => {
    expect(resolveDs4LaunchCtx({ configured: 16_384, ramTieredCtx: 131_072 })).toBe(65_536);
  });

  it('retains a genuinely smaller catalog bound', () => {
    expect(
      resolveDs4LaunchCtx({
        configured: 16_384,
        ramTieredCtx: 131_072,
        catalogMaxCtx: 32_768,
      }),
    ).toBe(32_768);
  });

  it('a memory-constrained host raises a low limit only to its 32K floor', () => {
    expect(
      resolveDs4LaunchCtx({
        configured: 16_384,
        ramTieredCtx: 131_072,
        minViableContextTokens: 32_768,
      }),
    ).toBe(32_768);
    // The tier is still an upper bound, and a smaller catalog cap still wins.
    expect(
      resolveDs4LaunchCtx({
        ramTieredCtx: 131_072,
        catalogMaxCtx: 24_576,
        minViableContextTokens: 32_768,
      }),
    ).toBe(24_576);
  });

  it('treats an absent cap and an absent override as unset, not as zero', () => {
    expect(
      resolveDs4LaunchCtx({
        configured: undefined,
        ramTieredCtx: 262_144,
        catalogMaxCtx: undefined,
      }),
    ).toBe(262_144);
  });
});
