import { describe, expect, it } from 'vitest';

import { formatJsonSchemaViolations, validateJsonSchema } from './validate.js';

describe('validateJsonSchema', () => {
  const toolSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete'] },
      id: { type: 'string', minLength: 1, maxLength: 80 },
      count: { type: 'integer', minimum: 0, maximum: 10 },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      nested: {
        type: 'object',
        properties: { flag: { type: 'boolean' } },
        required: ['flag'],
      },
    },
    required: ['action'],
  };

  it('accepts a conforming value', () => {
    expect(
      validateJsonSchema(
        { action: 'create', id: 'a1', count: 3, tags: ['x'], nested: { flag: true } },
        toolSchema,
      ),
    ).toEqual([]);
  });

  it('reports missing required properties at the parent path', () => {
    const violations = validateJsonSchema({}, toolSchema);
    expect(violations).toEqual([{ path: '', message: "missing required property 'action'" }]);
  });

  it('reports type mismatches with paths and stops descending on them', () => {
    const violations = validateJsonSchema({ action: 'create', count: 'three' }, toolSchema);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('/count');
    expect(violations[0]?.message).toContain('expected integer');
  });

  it('enforces enum, bounds, array items, and nested required', () => {
    const violations = validateJsonSchema(
      {
        action: 'destroy',
        count: 11,
        tags: ['a', 'b', 'c', 'd'],
        nested: {},
      },
      toolSchema,
    );
    const paths = violations.map((v) => v.path).sort();
    expect(paths).toEqual(['/action', '/count', '/nested', '/tags']);
  });

  it('validates items element-wise', () => {
    const violations = validateJsonSchema({ action: 'create', tags: ['ok', 5] }, toolSchema);
    expect(violations).toEqual([
      { path: '/tags/1', message: expect.stringContaining('expected string') },
    ]);
  });

  it('rejects unexpected properties only when additionalProperties is false', () => {
    expect(validateJsonSchema({ action: 'create', extra: 1 }, toolSchema)).toEqual([]);
    const strict = { ...toolSchema, additionalProperties: false };
    expect(validateJsonSchema({ action: 'create', extra: 1 }, strict)).toEqual([
      { path: '', message: "unexpected property 'extra'" },
    ]);
  });

  it('supports const, pattern, and type arrays', () => {
    expect(validateJsonSchema('abc', { type: ['string', 'null'], pattern: '^a' })).toEqual([]);
    expect(validateJsonSchema(null, { type: ['string', 'null'] })).toEqual([]);
    expect(validateJsonSchema('xbc', { pattern: '^a' })).toHaveLength(1);
    expect(validateJsonSchema(2, { const: 1 })).toHaveLength(1);
  });

  it('ignores unknown keywords and malformed schema fragments (permissive)', () => {
    expect(validateJsonSchema({ a: 1 }, { type: 'object', anyOf: [{ type: 'string' }] })).toEqual(
      [],
    );
    expect(validateJsonSchema('x', { pattern: '[' })).toEqual([]);
    expect(validateJsonSchema('anything', 42)).toEqual([]);
    expect(validateJsonSchema('anything', null)).toEqual([]);
  });

  it('treats boolean schemas per spec', () => {
    expect(validateJsonSchema('x', true)).toEqual([]);
    expect(validateJsonSchema('x', false)).toHaveLength(1);
  });

  it('does not recurse forever on self-referential schemas', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };
    const nested: Record<string, unknown> = { self: {} };
    (nested.self as Record<string, unknown>).self = nested;
    expect(() => validateJsonSchema(nested, cyclic)).not.toThrow();
  });

  it('formats violations compactly', () => {
    const text = formatJsonSchemaViolations([
      { path: '/a', message: 'expected string, got number' },
      { path: '', message: "missing required property 'b'" },
    ]);
    expect(text).toBe("/a: expected string, got number; missing required property 'b'");
  });
});
