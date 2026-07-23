import { describe, expect, it } from 'vitest';
import { defineScript } from './index.js';
import type { InferInput, InferOutput, ScriptMeta } from './index.js';

describe('defineScript', () => {
  it('returns its argument unchanged', () => {
    const meta = defineScript({
      name: 'noop',
      description: 'does nothing',
    });
    expect(meta.name).toBe('noop');
    expect(meta.description).toBe('does nothing');
  });

  it('preserves the inputs/outputs descriptor for downstream consumers', () => {
    const meta = defineScript({
      name: 'fetch',
      description: 'fetches stuff',
      inputs: {
        url: { type: 'string', description: 'endpoint', required: true },
        retries: { type: 'number', description: 'retry count', default: 3 },
      },
      outputs: {
        ok: { type: 'boolean', description: 'success flag' },
      },
    });
    expect(meta.inputs?.url?.type).toBe('string');
    expect(meta.outputs?.ok?.type).toBe('boolean');
  });
});

describe('InferInput / InferOutput (type-level)', () => {
  it('compiles for a realistic descriptor', () => {
    const meta = defineScript({
      name: 'fetch-rates',
      description: 'pulls daily rates',
      inputs: {
        base: {
          type: 'string',
          description: 'ISO currency',
          required: true,
        },
        source: {
          type: 'choice',
          description: 'provider',
          options: [{ value: 'ecb' }, { value: 'fed' }] as const,
          default: 'ecb',
        },
        force: { type: 'boolean', description: 'refetch', default: false },
        note: { type: 'string', description: 'optional note' },
      },
      outputs: {
        ok: { type: 'boolean', description: 'success' },
        count: { type: 'number', description: 'rows' },
      },
    } as const);

    type Input = InferInput<typeof meta extends ScriptMeta<infer I, infer _O> ? I : never>;
    type Output = InferOutput<typeof meta extends ScriptMeta<infer _I, infer O> ? O : never>;

    const sample: Input = { base: 'USD', source: 'ecb', force: false };
    expect(sample.base).toBe('USD');

    const out: Output = { ok: true, count: 3 };
    expect(out.ok).toBe(true);
  });
});
