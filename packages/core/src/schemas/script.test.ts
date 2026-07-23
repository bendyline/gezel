import { describe, expect, it } from 'vitest';
import {
  CraftbookStepSchema,
  ScriptMetaSchema,
  ScriptOutputPredicateSchema,
  ScriptRefSchema,
  ScriptRunSchema,
  normalizeScriptRefs,
} from './index.js';

describe('ScriptMetaSchema', () => {
  it('parses a minimal meta', () => {
    const meta = ScriptMetaSchema.parse({
      name: 'fetch-rates',
      description: 'Pulls daily FX rates.',
    });
    expect(meta.name).toBe('fetch-rates');
    expect(meta.inputs).toBeUndefined();
    expect(meta.outputs).toBeUndefined();
  });

  it('rejects an invalid name', () => {
    expect(() =>
      ScriptMetaSchema.parse({ name: '1-bad-start', description: 'desc desc desc' }),
    ).toThrow();
    expect(() =>
      ScriptMetaSchema.parse({ name: 'has spaces', description: 'desc desc desc' }),
    ).toThrow();
  });

  it('rejects a too-short description', () => {
    expect(() => ScriptMetaSchema.parse({ name: 'x', description: 'short' })).toThrow();
  });

  it('parses a fully-loaded meta with all input kinds', () => {
    const meta = ScriptMetaSchema.parse({
      name: 'kitchen-sink',
      description: 'Exercises every input/output field shape.',
      inputs: {
        s: { type: 'string', description: 'a string', required: true, pattern: '^[a-z]+$' },
        n: { type: 'number', description: 'a number', min: 0, max: 100, integer: true },
        b: { type: 'boolean', description: 'a flag', default: false },
        c: {
          type: 'choice',
          description: 'a choice',
          options: [{ value: 'a', label: 'Apple' }, { value: 'b' }],
          default: 'a',
        },
        r: { type: 'ref', description: 'pick a gezel', kind: 'gezel' },
        j: { type: 'json', description: 'anything', schema: { type: 'object' } },
      },
      outputs: {
        ok: { type: 'boolean', description: 'success flag' },
        pairs: { type: 'array', description: 'stuff', itemType: 'object' },
        obj: { type: 'object', description: 'arbitrary object' },
      },
      requires: ['llm', 'network', 'artifacts.write'],
    });
    expect(Object.keys(meta.inputs ?? {})).toHaveLength(6);
    expect(Object.keys(meta.outputs ?? {})).toHaveLength(3);
    expect(meta.requires).toEqual(['llm', 'network', 'artifacts.write']);
  });

  it('rejects a choice with zero options', () => {
    expect(() =>
      ScriptMetaSchema.parse({
        name: 'bad-choice',
        description: 'choice with no options',
        inputs: { c: { type: 'choice', description: 'pick', options: [] } },
      }),
    ).toThrow();
  });

  it('rejects unknown input type via discriminated union', () => {
    expect(() =>
      ScriptMetaSchema.parse({
        name: 'bad-input',
        description: 'unknown input type',
        inputs: { x: { type: 'date', description: 'a date' } as unknown as never },
      }),
    ).toThrow();
  });

  it('rejects an unknown capability', () => {
    expect(() =>
      ScriptMetaSchema.parse({
        name: 'bad-cap',
        description: 'declares a fake capability',
        requires: ['telepathy' as unknown as never],
      }),
    ).toThrow();
  });

  it('accepts a connector binding credential capability', () => {
    const meta = ScriptMetaSchema.parse({
      name: 'connector-fetch',
      description: 'Fetches records for a connector binding.',
      requires: ['network', 'credential:connector-github-issues.github-issues:deadbeef'],
    });
    expect(meta.requires).toContain('credential:connector-github-issues.github-issues:deadbeef');
  });
});

describe('ScriptOutputPredicateSchema', () => {
  it('parses each op shape', () => {
    expect(ScriptOutputPredicateSchema.parse({ op: 'always' })).toEqual({ op: 'always' });
    expect(ScriptOutputPredicateSchema.parse({ op: 'never' })).toEqual({ op: 'never' });
    expect(ScriptOutputPredicateSchema.parse({ op: 'ok' })).toEqual({ op: 'ok' });
    expect(
      ScriptOutputPredicateSchema.parse({ op: 'equals', field: 'a.b', value: 0 }),
    ).toMatchObject({ op: 'equals', field: 'a.b', value: 0 });
    expect(
      ScriptOutputPredicateSchema.parse({ op: 'exists', field: 'x', negate: true }),
    ).toMatchObject({ op: 'exists', field: 'x', negate: true });
    expect(ScriptOutputPredicateSchema.parse({ op: 'gt', field: 'count', value: 5 })).toMatchObject(
      { op: 'gt', field: 'count', value: 5 },
    );
  });

  it('rejects an unknown op', () => {
    expect(() => ScriptOutputPredicateSchema.parse({ op: 'matches', field: 'x' })).toThrow();
  });

  it('rejects equals without a field', () => {
    expect(() => ScriptOutputPredicateSchema.parse({ op: 'equals', value: 1 })).toThrow();
  });
});

describe('ScriptRefSchema', () => {
  it('parses with a name alone', () => {
    const ref = ScriptRefSchema.parse({ name: 'fetch' });
    expect(ref.name).toBe('fetch');
    expect(ref.autoAdvanceOnSuccess).toBeUndefined();
  });

  it('accepts both advance flags together', () => {
    const ref = ScriptRefSchema.parse({
      name: 'fetch',
      autoAdvanceOnSuccess: true,
      autoAdvanceWhen: { op: 'equals', field: 'count', value: 0 },
    });
    expect(ref.autoAdvanceOnSuccess).toBe(true);
    expect(ref.autoAdvanceWhen?.op).toBe('equals');
  });
});

describe('CraftbookStepSchema (onEnter/onExit additions)', () => {
  it('still parses steps without hooks', () => {
    const step = CraftbookStepSchema.parse({
      id: 's1',
      name: 'Review',
    });
    expect(step.onEnter).toBeUndefined();
    expect(step.onExit).toBeUndefined();
  });

  it('parses steps with both hooks (legacy single-ref shape)', () => {
    const step = CraftbookStepSchema.parse({
      id: 's1',
      name: 'Fetch',
      onEnter: {
        name: 'fetch-daily-rates',
        inputs: { base: 'USD' },
        autoAdvanceOnSuccess: true,
      },
      onExit: {
        name: 'write-summary',
      },
    });
    const [onEnter] = normalizeScriptRefs(step.onEnter);
    const [onExit] = normalizeScriptRefs(step.onExit);
    expect(onEnter?.name).toBe('fetch-daily-rates');
    expect(onEnter?.autoAdvanceOnSuccess).toBe(true);
    expect(onExit?.name).toBe('write-summary');
  });

  it('parses steps with hook LISTS and normalizes both shapes', () => {
    const step = CraftbookStepSchema.parse({
      id: 's1',
      name: 'Fetch',
      onEnter: [
        { name: 'prep-workspace' },
        { name: 'fetch-daily-rates', scope: 'standard', inputs: { base: 'USD' } },
      ],
    });
    const refs = normalizeScriptRefs(step.onEnter);
    expect(refs.map((r) => r.name)).toEqual(['prep-workspace', 'fetch-daily-rates']);
    expect(refs[1]?.scope).toBe('standard');
    expect(normalizeScriptRefs(undefined)).toEqual([]);
  });
});

describe('ScriptRunSchema', () => {
  it('parses a completed run record', () => {
    const run = ScriptRunSchema.parse({
      id: 'r1',
      projectId: 'demo',
      scriptName: 'fetch',
      startedAt: '2026-04-21T00:00:00Z',
      finishedAt: '2026-04-21T00:00:01Z',
      status: 'ok',
      trigger: { kind: 'manual', userInitiated: true },
      inputs: { base: 'USD' },
      output: { ok: true },
      calls: [
        {
          at: '2026-04-21T00:00:00.500Z',
          kind: 'fs.read',
          argsSummary: '"inbox/a"',
          durationMs: 5,
        },
      ],
      logs: '',
    });
    expect(run.status).toBe('ok');
    expect(run.calls).toHaveLength(1);
  });

  it('parses a step-triggered run', () => {
    const run = ScriptRunSchema.parse({
      id: 'r2',
      projectId: 'demo',
      scriptName: 'fetch',
      startedAt: '2026-04-21T00:00:00Z',
      status: 'running',
      trigger: { kind: 'step', taskRef: 'demo/4', stepId: 's1', moment: 'enter' },
      inputs: {},
      calls: [],
      logs: '',
    });
    expect(run.trigger.kind).toBe('step');
  });
});
