import type { ScriptMeta } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { ScriptInputError, validateScriptInput } from './input-validator.js';

function meta(inputs: NonNullable<ScriptMeta['inputs']>): ScriptMeta {
  return { name: 's', description: 'ten chars.', inputs };
}

describe('validateScriptInput', () => {
  it('applies defaults when the field is omitted', () => {
    const out = validateScriptInput(
      meta({ x: { type: 'string', description: 'x', default: 'hi' } }),
      {},
    );
    expect(out).toEqual({ x: 'hi' });
  });

  it('throws when a required field is missing', () => {
    expect(() =>
      validateScriptInput(
        meta({ base: { type: 'string', description: 'base', required: true } }),
        {},
      ),
    ).toThrow(ScriptInputError);
  });

  it('rejects unknown input keys', () => {
    expect(() =>
      validateScriptInput(meta({ x: { type: 'string', description: 'x' } }), { y: 'nope' }),
    ).toThrow(/unknown input/);
  });

  it('validates string pattern', () => {
    const valid = validateScriptInput(
      meta({
        base: { type: 'string', description: 'base', required: true, pattern: '^[A-Z]{3}$' },
      }),
      { base: 'USD' },
    );
    expect(valid.base).toBe('USD');
    expect(() =>
      validateScriptInput(
        meta({
          base: { type: 'string', description: 'base', required: true, pattern: '^[A-Z]{3}$' },
        }),
        { base: 'usd' },
      ),
    ).toThrow(/does not match pattern/);
  });

  it('validates number bounds and integer flag', () => {
    const validator = meta({
      n: { type: 'number', description: 'n', required: true, min: 0, max: 10, integer: true },
    });
    expect(validateScriptInput(validator, { n: 5 })).toEqual({ n: 5 });
    expect(() => validateScriptInput(validator, { n: 5.5 })).toThrow(/integer/);
    expect(() => validateScriptInput(validator, { n: -1 })).toThrow(/>= 0/);
    expect(() => validateScriptInput(validator, { n: 11 })).toThrow(/<= 10/);
  });

  it('restricts choices to declared options', () => {
    const validator = meta({
      src: {
        type: 'choice',
        description: 'src',
        required: true,
        options: [{ value: 'a' }, { value: 'b' }],
      },
    });
    expect(validateScriptInput(validator, { src: 'a' })).toEqual({ src: 'a' });
    expect(() => validateScriptInput(validator, { src: 'c' })).toThrow(/one of/);
  });

  it('accepts json inputs as-is', () => {
    const validator = meta({
      cfg: { type: 'json', description: 'cfg', required: true },
    });
    const out = validateScriptInput(validator, { cfg: { rules: [1, 2, 3] } });
    expect(out.cfg).toEqual({ rules: [1, 2, 3] });
  });

  it('returns empty object when no inputs are declared', () => {
    const out = validateScriptInput({ name: 's', description: 'ten chars.' }, undefined);
    expect(out).toEqual({});
  });
});
