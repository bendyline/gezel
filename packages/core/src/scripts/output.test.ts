import { describe, expect, it } from 'vitest';
import type { ScriptMeta } from '../schemas/script.js';
import { validateScriptOutput } from './output.js';

function meta(outputs?: ScriptMeta['outputs']): ScriptMeta {
  return { name: 's', description: 'ten chars.', ...(outputs ? { outputs } : {}) };
}

const TYPED = meta({
  s: { type: 'string', description: 's' },
  n: { type: 'number', description: 'n' },
  b: { type: 'boolean', description: 'b' },
  a: { type: 'array', description: 'a', itemType: 'string' },
  o: { type: 'object', description: 'o' },
  j: { type: 'json', description: 'j' },
});

describe('validateScriptOutput', () => {
  it('passes any value through when no outputs are declared', () => {
    expect(validateScriptOutput(meta(), 'anything')).toBe('anything');
  });

  it('accepts an object whose fields match their declared types', () => {
    const value = { s: 'x', n: 1, b: false, a: [], o: {}, j: 7, extra: true };
    expect(validateScriptOutput(TYPED, value)).toBe(value);
  });

  it.each([null, 'text', [1]])('requires an object when outputs are declared (%s)', (value) => {
    expect(() => validateScriptOutput(TYPED, value)).toThrow(/must be an object/);
  });

  it('reports a missing declared field', () => {
    expect(() =>
      validateScriptOutput(meta({ s: { type: 'string', description: 's' } }), {}),
    ).toThrow('output is missing declared field "s"');
  });

  it.each([
    ['s', 1, 'must be string, got number'],
    ['n', '1', 'must be number, got string'],
    ['n', Number.NaN, 'must be number, got number'],
    ['b', 'yes', 'must be boolean, got string'],
    ['a', {}, 'must be array, got object'],
    ['o', [], 'must be object, got array'],
    ['o', 'x', 'must be object, got string'],
  ])('rejects a mistyped %s field', (field, bad, message) => {
    const value = { s: 'x', n: 1, b: false, a: [], o: {}, j: 7, [field]: bad };
    expect(() => validateScriptOutput(TYPED, value)).toThrow(`output field "${field}" ${message}`);
  });

  it('allows null only for nullable scalars and json', () => {
    const nullable = meta({
      s: { type: 'string', description: 's', nullable: true },
      n: { type: 'number', description: 'n', nullable: true },
      b: { type: 'boolean', description: 'b', nullable: true },
      j: { type: 'json', description: 'j' },
    });
    expect(validateScriptOutput(nullable, { s: null, n: null, b: null, j: null })).toEqual({
      s: null,
      n: null,
      b: null,
      j: null,
    });
    for (const field of ['s', 'a', 'o']) {
      const value = { s: 'x', n: 1, b: false, a: [], o: {}, j: 7, [field]: null };
      expect(() => validateScriptOutput(TYPED, value), field).toThrow(/is null but type/);
    }
  });
});
