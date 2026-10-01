import { describe, expect, it } from 'vitest';
import {
  describeAcceptedShapes,
  describeClosestShape,
  objectShapesAt,
  renderShape,
} from './schema-shape-hint.js';

const ARTIFACT_URI = 'docblocks://artifacts/2995b61b';

/** A discriminated union with one identifying pattern, one permissive one. */
const UNION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    source: {
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'markdown' },
            // The real DocBlocks guard: excludes two control characters
            // and accepts everything else. Must never claim a value.
            markdown: { type: 'string', pattern: '^[^\\u0000\\u007f]*$' },
            name: { type: 'string' },
          },
          required: ['kind', 'markdown'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'artifact' },
            uri: { type: 'string', pattern: '^docblocks:\\/\\/artifacts\\/[A-Za-z0-9]+$' },
          },
          required: ['kind', 'uri'],
          additionalProperties: false,
        },
      ],
    },
  },
};

describe('objectShapesAt', () => {
  it('flattens a union into its object branches with discriminators', () => {
    const shapes = objectShapesAt(UNION_SCHEMA, ['source']);
    expect(shapes).toHaveLength(2);
    expect(shapes[0]?.discriminator).toEqual({ key: 'kind', value: 'markdown' });
    expect(shapes[0]?.optional).toEqual(['name']);
    expect(shapes[1]?.discriminator).toEqual({ key: 'kind', value: 'artifact' });
    expect(shapes.every((s) => s.closed)).toBe(true);
  });

  it('returns nothing for a position that declares no object', () => {
    expect(objectShapesAt(UNION_SCHEMA, ['source', 'nope'])).toEqual([]);
    expect(objectShapesAt(undefined, ['source'])).toEqual([]);
  });

  it('resolves $ref branches against the document root', () => {
    const withRef: Record<string, unknown> = {
      type: 'object',
      properties: { target: { $ref: '#/$defs/artifact' } },
      $defs: {
        artifact: {
          type: 'object',
          properties: { kind: { type: 'string', const: 'artifact' }, uri: { type: 'string' } },
          required: ['kind', 'uri'],
        },
      },
    };
    expect(objectShapesAt(withRef, ['target']).map(renderShape)).toEqual([
      '{ "kind": "artifact", "uri": … }',
    ]);
  });
});

describe('describeAcceptedShapes', () => {
  it('lists required fields only, discriminator first', () => {
    const out = describeAcceptedShapes(UNION_SCHEMA, ['source'], 42);
    expect(out).toBe(
      '`source` must be an object in one of these shapes: `{ "kind": "markdown", "markdown": … } | { "kind": "artifact", "uri": … }`.',
    );
  });

  it('finishes the call when one branch identifies the scalar', () => {
    const out = describeAcceptedShapes(UNION_SCHEMA, ['source'], ARTIFACT_URI);
    expect(out).toContain('belongs in `uri`');
    expect(out).toContain(`{ "kind": "artifact", "uri": "${ARTIFACT_URI}" }`);
  });

  it('never lets a merely-permissive pattern claim a value', () => {
    // `markdown` accepts "deck.md" and every other string; accepting is
    // not identifying, and a confident wrong branch is worse than none.
    const out = describeAcceptedShapes(UNION_SCHEMA, ['source'], 'deck.md');
    expect(out).toContain('must be an object in one of these shapes');
    expect(out).not.toContain('belongs in');
  });

  it('elides an over-long value rather than quoting it whole', () => {
    const long = `docblocks://artifacts/${'a'.repeat(400)}`;
    const wide: Record<string, unknown> = JSON.parse(JSON.stringify(UNION_SCHEMA));
    const out = describeAcceptedShapes(wide, ['source'], long);
    expect(out).toContain('…"');
    expect(out?.length).toBeLessThan(long.length + 300);
  });
});

describe('describeClosestShape', () => {
  it('weighs a required-field hit above a stray key', () => {
    const out = describeClosestShape(UNION_SCHEMA, ['source', 'kind'], {
      source: { format: 'pptx', uri: ARTIFACT_URI },
    });
    expect(out).toContain('`{ "kind": "artifact", "uri": … }`');
    expect(out).toContain('set `kind: "artifact"`');
    expect(out).toContain('remove `format` (not allowed in this shape)');
  });

  it('names the fields a matched branch is still missing', () => {
    const out = describeClosestShape(UNION_SCHEMA, ['source', 'kind'], {
      source: { name: 'deck' },
    });
    expect(out).toContain('add `markdown`');
  });

  it('stays silent when nothing resembles a branch', () => {
    expect(
      describeClosestShape(UNION_SCHEMA, ['source', 'kind'], { source: { wholly: 'unrelated' } }),
    ).toBeNull();
  });

  it('stays silent when the args do not reach the union position', () => {
    expect(
      describeClosestShape(UNION_SCHEMA, ['source', 'kind'], { source: 'a string' }),
    ).toBeNull();
    expect(describeClosestShape(UNION_SCHEMA, [], { source: {} })).toBeNull();
    expect(describeClosestShape(undefined, ['source', 'kind'], { source: {} })).toBeNull();
  });
});
