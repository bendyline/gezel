import { describe, expect, it } from 'vitest';
import { type CraftbookToolsetNeed, unmetToolsets } from './craftbook.js';
import { HookSpecSchema } from './hook.js';

const NEEDS: CraftbookToolsetNeed[] = [
  { toolsetId: 'usb-camera', autoAllow: true },
  { toolsetId: 'github', optional: true },
  { toolsetId: 'weather' },
];

describe('unmetToolsets', () => {
  it('returns no unmet needs when toolsets is absent or empty', () => {
    expect(unmetToolsets(undefined, new Set())).toEqual([]);
    expect(unmetToolsets([], new Set())).toEqual([]);
  });

  it('reports required toolsets that are not installed', () => {
    const unmet = unmetToolsets(NEEDS, new Set());
    expect(unmet.map((t) => t.toolsetId)).toEqual(['usb-camera', 'weather']);
  });

  it('never reports optional toolsets, installed or not', () => {
    const unmet = unmetToolsets(NEEDS, new Set(['usb-camera', 'weather']));
    // both required ones installed → nothing unmet; optional github irrelevant
    expect(unmet).toEqual([]);
    const stillOptionalOnly = unmetToolsets([{ toolsetId: 'github', optional: true }], new Set());
    expect(stillOptionalOnly).toEqual([]);
  });

  it('clears a required need once it is installed', () => {
    const unmet = unmetToolsets(NEEDS, new Set(['usb-camera']));
    expect(unmet.map((t) => t.toolsetId)).toEqual(['weather']);
  });
});

describe('HookSpec script/decision exclusivity', () => {
  it('accepts a script-only hook', () => {
    const res = HookSpecSchema.safeParse({
      phase: 'PreToolUse',
      matcher: '.*',
      script: { name: 'guard' },
    });
    expect(res.success).toBe(true);
  });

  it('accepts a static-decision hook with no script', () => {
    const res = HookSpecSchema.safeParse({
      phase: 'PreToolUse',
      matcher: '^(a|b)$',
      decision: 'allow',
    });
    expect(res.success).toBe(true);
  });

  it('rejects a hook that sets both script and decision', () => {
    const res = HookSpecSchema.safeParse({
      phase: 'PreToolUse',
      script: { name: 'guard' },
      decision: 'allow',
    });
    expect(res.success).toBe(false);
  });

  it('rejects a hook that sets neither script nor decision', () => {
    const res = HookSpecSchema.safeParse({ phase: 'PreToolUse', matcher: '.*' });
    expect(res.success).toBe(false);
  });
});
