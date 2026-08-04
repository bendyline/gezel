import { describe, expect, it } from 'vitest';
import { resolveLlamaCppKvCacheType, planLlamaCppKv } from './kv-cache-type.js';

describe('resolveLlamaCppKvCacheType', () => {
  it('defaults the Gemma family to f16 (q8_0 corrupts its KV cache)', () => {
    expect(resolveLlamaCppKvCacheType({ architecture: 'gemma4' })).toBe('f16');
    expect(resolveLlamaCppKvCacheType({ architecture: 'gemma3' })).toBe('f16');
    expect(resolveLlamaCppKvCacheType({ architecture: 'Gemma' })).toBe('f16');
  });

  it('catches Gemma via the model id when GGUF architecture is missing', () => {
    expect(resolveLlamaCppKvCacheType({ modelId: 'gemma4-12b-q4' })).toBe('f16');
  });

  it('defaults other families to q8_0', () => {
    expect(resolveLlamaCppKvCacheType({ architecture: 'qwen2' })).toBe('q8_0');
    expect(resolveLlamaCppKvCacheType({ architecture: 'llama' })).toBe('q8_0');
    expect(resolveLlamaCppKvCacheType({})).toBe('q8_0');
  });

  it('lets an explicit operator override win over the family default', () => {
    expect(resolveLlamaCppKvCacheType({ architecture: 'gemma4', override: 'q8_0' })).toBe('q8_0');
    expect(resolveLlamaCppKvCacheType({ architecture: 'gemma4', override: 'q4_0' })).toBe('q4_0');
    expect(resolveLlamaCppKvCacheType({ architecture: 'qwen2', override: 'f16' })).toBe('f16');
  });
});

describe('planLlamaCppKv — trade f16 KV for a second slot', () => {
  const gemma = { architecture: 'gemma3', modelId: 'gemma4-12b-q4' };
  const qwen = { architecture: 'qwen3', modelId: 'qwen3.6-27b-q4' };
  const ceil = (f16: number, q8: number) => (kv: string) => (kv === 'f16' ? f16 : q8);

  it('upgrades gemma to q8_0 when f16 forces one slot and q8_0 buys two', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: false,
      ceilingFor: ceil(1, 2),
      maxSlots: 4,
    });
    expect(plan).toEqual({ kvCacheType: 'q8_0', upgraded: true });
  });

  it('keeps f16 when it already fits two slots', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: false,
      ceilingFor: ceil(2, 4),
      maxSlots: 4,
    });
    expect(plan).toEqual({ kvCacheType: 'f16', upgraded: false });
  });

  it('keeps f16 when even q8_0 cannot reach two slots — no free lunch, no pointless trade', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: false,
      ceilingFor: ceil(1, 1),
      maxSlots: 4,
    });
    expect(plan).toEqual({ kvCacheType: 'f16', upgraded: false });
  });

  it('never overrides an explicit operator kvCacheType', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      override: 'f16',
      slotsConfigured: false,
      ceilingFor: ceil(1, 2),
      maxSlots: 4,
    });
    expect(plan).toEqual({ kvCacheType: 'f16', upgraded: false });
  });

  it('never trades when the operator pinned the slot count', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: true,
      ceilingFor: ceil(1, 2),
      maxSlots: 4,
    });
    expect(plan).toEqual({ kvCacheType: 'f16', upgraded: false });
  });

  it('is inert for non-gemma families (they already default q8_0)', () => {
    const plan = planLlamaCppKv({
      ...qwen,
      slotsConfigured: false,
      ceilingFor: ceil(1, 2),
      maxSlots: 4,
    });
    expect(plan).toEqual({ kvCacheType: 'q8_0', upgraded: false });
  });

  it('is inert when policy caps slots at one anyway', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: false,
      ceilingFor: ceil(1, 4),
      maxSlots: 1,
    });
    expect(plan).toEqual({ kvCacheType: 'f16', upgraded: false });
  });
});
