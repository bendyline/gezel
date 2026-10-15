import { describe, expect, it } from 'vitest';
import { scriptToolArgs } from './script-tool-args.js';

const BS = String.fromCharCode(92);

describe('scriptToolArgs', () => {
  it('turns twice-escaped line breaks in text into real ones', () => {
    const plan = `Visit Belem Tower.${BS}nLunch at a pastelaria.${BS}nWalk the river.`;
    expect(scriptToolArgs({ date: 'Day 2', plan }).plan).toBe(
      'Visit Belem Tower.\nLunch at a pastelaria.\nWalk the river.',
    );
  });

  it('leaves text with real line breaks, other types, and non-text schemas alone', () => {
    const mixed = `Line one\nmentions ${BS}n literally`;
    const inputs = { properties: { code: { type: 'object' }, note: { type: 'string' } } };
    const out = scriptToolArgs({ note: mixed, count: 3, code: `a${BS}nb` }, inputs);
    expect(out.note).toBe(mixed);
    expect(out.count).toBe(3);
    expect(out.code).toBe(`a${BS}nb`);
  });

  it('repairs each text item of a list', () => {
    expect(scriptToolArgs({ items: [`Passport${BS}nVisa`, 4] }).items).toEqual([
      'Passport\nVisa',
      4,
    ]);
  });
});
