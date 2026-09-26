import { describe, expect, it } from 'vitest';
import {
  type NativeToolSchema,
  decodeNativeToolArguments,
  nativeToolParameters,
  nativeToolSpecs,
} from '../tools/native-tools.js';
import { portableToolSurface } from './product-tools.js';
import { portableFixture } from './test-files.js';

describe('native tool argument schemas', () => {
  it('keeps property order and maps unions, enums, nullables and open objects', () => {
    const schema = nativeToolParameters({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        content: { type: 'string' },
        occurrence: {
          description: "A 1-based index, or 'all'.",
          anyOf: [
            { type: 'integer', minimum: 1 },
            { type: 'string', enum: ['all'] },
          ],
        },
        scope: { type: 'string', enum: ['project', 'user'] },
        note: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        input: { type: 'object', additionalProperties: {} },
        none: { type: 'object', properties: {}, additionalProperties: false },
        mode: { oneOf: [{ const: 'fast' }, { const: 'careful' }] },
      },
      required: ['path', 'content', 'note'],
      additionalProperties: false,
    });
    expect(schema.properties.map(({ name }) => name)).toEqual([
      'path',
      'content',
      'occurrence',
      'scope',
      'note',
      'tags',
      'input',
      'none',
      'mode',
    ]);
    expect(schema.properties.map(({ optional }) => optional)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    const byName = Object.fromEntries(schema.properties.map((p) => [p.name, p.schema]));
    expect(byName.path).toEqual({ kind: 'string', description: 'File path.' });
    expect(byName.occurrence).toEqual({
      kind: 'anyOf',
      description: "A 1-based index, or 'all'.",
      choices: [{ kind: 'integer' }, { kind: 'string', choices: ['all'] }],
    });
    expect(byName.scope).toEqual({ kind: 'string', choices: ['project', 'user'] });
    expect(byName.note).toEqual({ kind: 'string' });
    expect(byName.tags).toEqual({ kind: 'array', items: { kind: 'string' }, maxItems: 5 });
    expect(byName.input).toEqual({ kind: 'json', description: 'A JSON object, written as text.' });
    expect(byName.none).toEqual({ kind: 'object', properties: [] });
    expect(byName.mode).toEqual({ kind: 'string', choices: ['fast', 'careful'] });
  });

  it('drops descriptions on request, except the hint a JSON-text value needs', () => {
    const schema = nativeToolParameters(
      {
        type: 'object',
        description: 'Arguments.',
        properties: {
          path: { type: 'string', description: 'File path.' },
          input: { type: 'object', description: 'Script input.' },
        },
      },
      false,
    );
    expect(schema).toEqual({
      kind: 'object',
      properties: [
        { name: 'path', optional: true, schema: { kind: 'string' } },
        {
          name: 'input',
          optional: true,
          schema: { kind: 'json', description: 'A JSON object, written as text.' },
        },
      ],
    });
  });

  it('restores JSON-text values, including inside arrays, and leaves other values alone', () => {
    const schema = nativeToolParameters({
      type: 'object',
      properties: {
        input: { type: 'object', additionalProperties: {} },
        rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
        name: { type: 'string' },
      },
    });
    expect(
      decodeNativeToolArguments(schema, {
        input: '{"count":3,"fields":{"item":"lamp"}}',
        rows: ['{"a":1}', 'not json'],
        name: '{"stays":"text"}',
      }),
    ).toEqual({
      input: { count: 3, fields: { item: 'lamp' } },
      rows: [{ a: 1 }, 'not json'],
      name: '{"stays":"text"}',
    });
  });

  it('converts every tool the portable runtime publishes', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const gezel = await store.createGezel({ name: 'Native tester', role: 'Generalist' });
    const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
    const inventory = await portableToolSurface(store, session, true);
    expect(inventory.length).toBeGreaterThan(10);
    const kinds = new Set([
      'string',
      'integer',
      'number',
      'boolean',
      'json',
      'array',
      'object',
      'anyOf',
    ]);
    const walk = (node: NativeToolSchema, path: string): void => {
      expect(kinds.has(node.kind), path).toBe(true);
      if (node.kind === 'array') walk(node.items, `${path}[]`);
      if (node.kind === 'anyOf') node.choices.forEach((choice, i) => walk(choice, `${path}|${i}`));
      if (node.kind === 'object')
        for (const property of node.properties) walk(property.schema, `${path}.${property.name}`);
    };
    for (const tool of inventory) {
      const schema = nativeToolParameters(tool.parameters);
      expect(schema.kind, tool.name).toBe('object');
      walk(schema, tool.name);
    }
    const sizes = (['full', 'compact', 'core', 'none'] as const).map(
      (listing) => JSON.stringify(nativeToolSpecs(inventory, listing)).length,
    );
    expect(sizes[1]).toBeLessThan(sizes[0]!);
    expect(sizes[2]).toBeLessThan(sizes[1]!);
    expect(nativeToolSpecs(inventory, 'none')).toEqual([]);
    const core = nativeToolSpecs(inventory, 'core').map(({ name }) => name);
    expect(core).toContain('read_file');
    expect(core).toContain('write_artifact');
    expect(core.every((name) => inventory.some((tool) => tool.name === name))).toBe(true);
  });
});
