import { describe, expect, it } from 'vitest';
import {
  F16_PREFERRED_CTX_CAP_TOKENS,
  planLlamaCppKv,
  resolveLlamaCppKvCacheType,
} from './kv-cache-type.js';

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
  // Context-independent ceilings: these legacy cases exercise the slot
  // dimension only.
  const ceil = (f16: number, q8: number) => (kv: string) => (kv === 'f16' ? f16 : q8);
  // Neutral context inputs for cases that are not about the context cap.
  const ctx = { requestedCtxTokens: 32_768, minimumCtxTokens: 32_768, ctxConfigured: false };

  it('upgrades gemma to q8_0 when f16 forces one slot and q8_0 buys two', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: false,
      ...ctx,
      ceilingFor: ceil(1, 2),
      maxSlots: 4,
    });
    expect(plan).toMatchObject({ kvCacheType: 'q8_0', upgraded: true });
  });

  it('keeps f16 when it already fits two slots', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: false,
      ...ctx,
      ceilingFor: ceil(2, 4),
      maxSlots: 4,
    });
    expect(plan).toMatchObject({ kvCacheType: 'f16', upgraded: false });
  });

  it('keeps f16 when even q8_0 cannot reach two slots — no free lunch, no pointless trade', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: false,
      ...ctx,
      ceilingFor: ceil(1, 1),
      maxSlots: 4,
    });
    expect(plan).toMatchObject({ kvCacheType: 'f16', upgraded: false });
  });

  it('never overrides an explicit operator kvCacheType', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      override: 'f16',
      slotsConfigured: false,
      ...ctx,
      ceilingFor: ceil(1, 2),
      maxSlots: 4,
    });
    expect(plan).toMatchObject({ kvCacheType: 'f16', upgraded: false });
  });

  it('never trades when the operator pinned the slot count', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: true,
      ...ctx,
      ceilingFor: ceil(1, 2),
      maxSlots: 4,
    });
    expect(plan).toMatchObject({ kvCacheType: 'f16', upgraded: false });
  });

  it('non-gemma now prefers f16 at fewer slots over q8_0 at more (2026-08-28 policy)', () => {
    // The pre-policy behavior (blanket q8_0) is retired: f16 fits one slot
    // here, and one fast slot beats two slower ones.
    const plan = planLlamaCppKv({
      ...qwen,
      slotsConfigured: false,
      ...ctx,
      ceilingFor: ceil(1, 2),
      maxSlots: 4,
    });
    expect(plan).toMatchObject({ kvCacheType: 'f16', upgraded: false });
  });

  it('is inert when policy caps slots at one anyway', () => {
    const plan = planLlamaCppKv({
      ...gemma,
      slotsConfigured: false,
      ...ctx,
      ceilingFor: ceil(1, 4),
      maxSlots: 1,
    });
    expect(plan).toMatchObject({ kvCacheType: 'f16', upgraded: false });
  });
});

describe('planLlamaCppKv — f16-first ladder (non-Gemma, 2026-08-28 policy)', () => {
  // Measured basis: q8_0 costs ~6% decode flat and −6%→−17% prefill as
  // context grows 8k→90k (reports/llama-kv-q8-longctx-20260828.md). Favor
  // f16 when memory allows, sacrificing slots first, then context > 64k.
  const qwen = { architecture: 'qwen3', modelId: 'qwen3.8-27b-q4' };
  const base = { ...qwen, slotsConfigured: false as const, maxSlots: 4 };

  it('takes f16 outright when it fits the full plan', () => {
    const plan = planLlamaCppKv({
      ...base,
      requestedCtxTokens: 131_072,
      minimumCtxTokens: 32_768,
      ctxConfigured: false,
      ceilingFor: () => 4,
    });
    expect(plan).toMatchObject({ kvCacheType: 'f16' });
    expect(plan.ctxCapTokens).toBeUndefined();
  });

  it('sacrifices slots before precision', () => {
    const plan = planLlamaCppKv({
      ...base,
      requestedCtxTokens: 131_072,
      minimumCtxTokens: 32_768,
      ctxConfigured: false,
      ceilingFor: (kv) => (kv === 'f16' ? 1 : 4),
    });
    expect(plan).toMatchObject({ kvCacheType: 'f16' });
    expect(plan.ctxCapTokens).toBeUndefined();
  });

  it('sacrifices context above 64k when slots alone are not enough', () => {
    const plan = planLlamaCppKv({
      ...base,
      requestedCtxTokens: 131_072,
      minimumCtxTokens: 32_768,
      ctxConfigured: false,
      // f16 fits nothing at 131k but one slot at 64k.
      ceilingFor: (kv, ctxTokens) =>
        kv === 'f16' ? (ctxTokens <= F16_PREFERRED_CTX_CAP_TOKENS ? 1 : 0) : 4,
    });
    expect(plan).toMatchObject({ kvCacheType: 'f16', ctxCapTokens: F16_PREFERRED_CTX_CAP_TOKENS });
  });

  it('falls back to q8_0 when f16 cannot fit even one 64k slot', () => {
    const plan = planLlamaCppKv({
      ...base,
      requestedCtxTokens: 131_072,
      minimumCtxTokens: 32_768,
      ctxConfigured: false,
      ceilingFor: (kv) => (kv === 'f16' ? 0 : 2),
    });
    expect(plan).toMatchObject({ kvCacheType: 'q8_0' });
    expect(plan.ctxCapTokens).toBeUndefined();
  });

  it('never caps an explicitly configured context', () => {
    const plan = planLlamaCppKv({
      ...base,
      requestedCtxTokens: 131_072,
      minimumCtxTokens: 32_768,
      ctxConfigured: true,
      ceilingFor: (kv, ctxTokens) =>
        kv === 'f16' ? (ctxTokens <= F16_PREFERRED_CTX_CAP_TOKENS ? 1 : 0) : 2,
    });
    expect(plan).toMatchObject({ kvCacheType: 'q8_0' });
    expect(plan.ctxCapTokens).toBeUndefined();
  });

  it('never caps below the admission floor (model-max style minimums)', () => {
    const plan = planLlamaCppKv({
      ...base,
      requestedCtxTokens: 131_072,
      minimumCtxTokens: 131_072,
      ctxConfigured: false,
      ceilingFor: (kv, ctxTokens) =>
        kv === 'f16' ? (ctxTokens <= F16_PREFERRED_CTX_CAP_TOKENS ? 1 : 0) : 2,
    });
    expect(plan).toMatchObject({ kvCacheType: 'q8_0' });
    expect(plan.ctxCapTokens).toBeUndefined();
  });

  it('honors an explicit slot count: f16 only when it fits that many', () => {
    const fits = planLlamaCppKv({
      ...qwen,
      slotsConfigured: true,
      configuredSlots: 2,
      maxSlots: 4,
      requestedCtxTokens: 32_768,
      minimumCtxTokens: 32_768,
      ctxConfigured: false,
      ceilingFor: (kv) => (kv === 'f16' ? 2 : 4),
    });
    expect(fits).toMatchObject({ kvCacheType: 'f16' });
    const doesNot = planLlamaCppKv({
      ...qwen,
      slotsConfigured: true,
      configuredSlots: 2,
      maxSlots: 4,
      requestedCtxTokens: 32_768,
      minimumCtxTokens: 32_768,
      ctxConfigured: false,
      ceilingFor: (kv) => (kv === 'f16' ? 1 : 4),
    });
    expect(doesNot).toMatchObject({ kvCacheType: 'q8_0' });
  });

  it('gemma keeps its own shape — the slot-sacrifice ladder does not apply', () => {
    // Gemma f16 is a correctness default with a deliberate q8-for-second-slot
    // trade (SWA re-prefill pathology). The general ladder must not turn that
    // trade off by "sacrificing slots for f16".
    const plan = planLlamaCppKv({
      architecture: 'gemma3',
      modelId: 'gemma4-12b-q4',
      slotsConfigured: false,
      maxSlots: 4,
      requestedCtxTokens: 65_536,
      minimumCtxTokens: 32_768,
      ctxConfigured: false,
      ceilingFor: (kv) => (kv === 'f16' ? 1 : 2),
    });
    expect(plan).toMatchObject({ kvCacheType: 'q8_0', upgraded: true });
  });
});
