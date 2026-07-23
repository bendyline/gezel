import { ExpectedDeliverableSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coerceJsonArray, coerceJsonObject, coerceStringArray } from './zod-coerce.js';

describe('coerceJsonObject', () => {
  const schema = coerceJsonObject(
    z.object({ kind: z.enum(['gezel', 'user']), gezelId: z.string().optional() }),
  );

  it('passes a real object through unchanged', () => {
    const out = schema.parse({ kind: 'gezel', gezelId: 'leo' });
    expect(out).toEqual({ kind: 'gezel', gezelId: 'leo' });
  });

  it('parses a JSON-stringified object (the Qwen 3.6 failure mode)', () => {
    const out = schema.parse('{"kind":"gezel","gezelId":"leo"}');
    expect(out).toEqual({ kind: 'gezel', gezelId: 'leo' });
  });

  it('parses a JSON-stringified object with whitespace and escaped quotes', () => {
    const out = schema.parse('  {"kind": "user"}  ');
    expect(out).toEqual({ kind: 'user' });
  });

  it('passes non-object-shaped strings through to the inner validator', () => {
    expect(() => schema.parse('not-json')).toThrow();
    expect(() => schema.parse('"just-a-string"')).toThrow();
  });

  it('passes through arrays so the inner validator can produce a real type error', () => {
    expect(() => schema.parse(['kind', 'gezel'])).toThrow();
  });

  it('parses a JSON-stringified expectedDeliverable handoff hint', () => {
    const out = coerceJsonObject(ExpectedDeliverableSchema).parse(
      '{"kind":"file","filePath":"index.html"}',
    );
    expect(out).toEqual({ kind: 'file', filePath: 'index.html' });
  });
});

describe('coerceJsonArray', () => {
  const schema = coerceJsonArray(
    z.array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
      }),
    ),
  );

  it('passes a real array through unchanged', () => {
    const out = schema.parse([{ name: 'Phase 1' }, { name: 'Phase 2', description: 'do thing' }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'Phase 1' });
  });

  it('parses a JSON-stringified array of phase objects', () => {
    const out = schema.parse(
      '[{"name":"Set up project structure","description":"HTML canvas"},{"name":"Player ship"}]',
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.name).toBe('Set up project structure');
    expect(out[1]?.name).toBe('Player ship');
  });

  it('parses a JSON-stringified array with leading whitespace', () => {
    const out = schema.parse('  [{"name":"x"}]');
    expect(out).toHaveLength(1);
  });

  it('passes non-array-shaped strings through', () => {
    expect(() => schema.parse('not-an-array')).toThrow();
    expect(() => schema.parse('{"name":"x"}')).toThrow();
  });

  it('falls back to the original string when JSON.parse fails so the inner schema reports the real shape mismatch', () => {
    expect(() => schema.parse('[malformed json')).toThrow();
  });
});

describe('coerceJsonArray with optional inner', () => {
  const schema = coerceJsonArray(z.array(z.string()).max(20).optional());

  it('passes undefined through (optional case)', () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it('parses the ask_user_question failure mode: stringified choices', () => {
    const out = schema.parse('["Single-player","Multiplayer (local)","Multiplayer (online)"]');
    expect(out).toEqual(['Single-player', 'Multiplayer (local)', 'Multiplayer (online)']);
  });
});

describe('coerceStringArray', () => {
  const schema = coerceStringArray(z.array(z.string()).optional());

  it('passes undefined through (optional case)', () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it('passes a real string array through unchanged', () => {
    expect(schema.parse(['--runInBand', 'contract-test.mjs'])).toEqual([
      '--runInBand',
      'contract-test.mjs',
    ]);
  });

  it('parses a JSON-stringified string array', () => {
    expect(schema.parse('["--filter","bookstore api"]')).toEqual(['--filter', 'bookstore api']);
  });

  it('splits a shell-ish argv string', () => {
    expect(schema.parse('--filter "bookstore api" --watch=false')).toEqual([
      '--filter',
      'bookstore api',
      '--watch=false',
    ]);
  });

  it('coerces an empty string to an empty argv list', () => {
    expect(schema.parse('   ')).toEqual([]);
  });

  it('leaves object-shaped strings for the inner validator to reject', () => {
    expect(() => schema.parse('{"path":"contract-test.mjs"}')).toThrow();
  });
});
