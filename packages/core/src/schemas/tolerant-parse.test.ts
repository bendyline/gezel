import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CraftbookDocSchema, parseTolerant } from './index.js';

const bookWithChecks = (checks: unknown[]) => ({
  name: 'Weekly admin',
  steps: [{ id: 'draft', name: 'Draft', gate: { checks } }],
});

const minBytes = { kind: 'minBytes', file: 'quote.md', bytes: 10 };

describe('parseTolerant', () => {
  it('returns strict-parse output untouched when nothing is unknown', () => {
    const raw = bookWithChecks([minBytes]);
    const result = parseTolerant(CraftbookDocSchema, raw);
    expect(result).toEqual({ ok: true, data: CraftbookDocSchema.parse(raw), ignored: [] });
  });

  // A gilde book adopting a check this build predates used to vanish whole,
  // and the live-update gate then refused every gilde update over it.
  it('drops only the gate check whose kind this build does not know', () => {
    const raw = bookWithChecks([minBytes, { kind: 'teleport', file: 'quote.md' }]);
    const result = parseTolerant(CraftbookDocSchema, raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.steps[0]?.gate).toMatchObject({ checks: [minBytes] });
    expect(result.ignored).toEqual(['steps[0].gate.checks[1] (kind "teleport")']);
  });

  it('removes several unknown elements of one array without shifting onto a sibling', () => {
    const raw = bookWithChecks([
      { kind: 'teleport', file: 'a' },
      minBytes,
      { kind: 'levitate', file: 'b' },
      { ...minBytes, file: 'second.md' },
    ]);
    const result = parseTolerant(CraftbookDocSchema, raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.steps[0]?.gate).toMatchObject({
      checks: [minBytes, { ...minBytes, file: 'second.md' }],
    });
    expect(result.ignored).toHaveLength(2);
  });

  it('drops an optional field holding a value this build does not accept', () => {
    const schema = z.object({ name: z.string(), tier: z.enum(['small', 'large']).optional() });
    expect(parseTolerant(schema, { name: 'x', tier: 'galactic' })).toEqual({
      ok: true,
      data: { name: 'x' },
      ignored: ['tier'],
    });
  });

  it('removes a key a strict object does not recognize', () => {
    const schema = z.object({ policy: z.object({ allow: z.array(z.string()) }).strict() });
    expect(parseTolerant(schema, { policy: { allow: ['read_file'], future: true } })).toEqual({
      ok: true,
      data: { policy: { allow: ['read_file'] } },
      ignored: ['policy.future (unrecognized key)'],
    });
  });

  it('never removes a required value, and reports the strict issues when it would have to', () => {
    const schema = z.object({ name: z.string(), mode: z.enum(['a', 'b']) });
    const raw = { name: 'x', mode: 'c' };
    const result = parseTolerant(schema, raw);
    expect(result).toEqual({ ok: false, issues: schema.safeParse(raw).error?.issues });
  });

  it('fails an item that is itself of an unknown kind', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a') }),
      z.object({ kind: z.literal('b') }),
    ]);
    expect(parseTolerant(schema, { kind: 'z' }).ok).toBe(false);
  });

  it('leaves refinement failures to fail', () => {
    const schema = z
      .object({ min: z.number(), max: z.number() })
      .refine((v) => v.min <= v.max, { path: ['max'] });
    expect(parseTolerant(schema, { min: 5, max: 1 }).ok).toBe(false);
  });

  it('prefers repairing inside a plain union over dropping the union value', () => {
    const schema = z.object({
      target: z
        .union([
          z.object({ at: z.enum(['start', 'end']), items: z.array(z.enum(['x', 'y'])) }),
          z.object({ items: z.array(z.enum(['x', 'y'])) }),
        ])
        .optional(),
    });
    expect(parseTolerant(schema, { target: { items: ['x', 'q', 'y'] } })).toEqual({
      ok: true,
      data: { target: { items: ['x', 'y'] } },
      ignored: ['target.items[1]'],
    });
  });

  it('does not mutate the value it was given', () => {
    const raw = bookWithChecks([minBytes, { kind: 'teleport', file: 'x' }]);
    const before = structuredClone(raw);
    parseTolerant(CraftbookDocSchema, raw);
    expect(raw).toEqual(before);
  });
});
