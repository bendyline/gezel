import { describe, expect, it } from 'vitest';
import { findHermesFunctionToolCallSpans } from './local-tool-call-salvage.js';
import {
  coerceArgsToSchema,
  coerceToolCallArgs,
  looksLikeFlattenedStructuralArg,
} from './tool-arg-schema-coercion.js';

/**
 * DocBlocks `convert_document` — the tool that surfaced this bug. `source`
 * is an object, `targets` an array; the Hermes markup the model emits can
 * carry neither, so both arrive as strings.
 */
const CONVERT_SCHEMA = {
  type: 'object',
  properties: {
    source: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        rootId: { type: 'string' },
        path: { type: 'string' },
      },
    },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: { format: { type: 'string' }, slideCount: { type: 'number' } },
      },
    },
    themeId: { type: 'string' },
    autoTemplates: { type: 'boolean' },
  },
};

describe('coerceArgsToSchema', () => {
  it('reinterprets object and array args the markup flattened into strings', () => {
    const { args, repaired } = coerceArgsToSchema(
      {
        source: '{"kind":"file","rootId":"root-cec43","path":"deck.md"}',
        targets: '[{"format":"pptx"}]',
        themeId: 'minimalist',
        autoTemplates: 'true',
      },
      CONVERT_SCHEMA,
    );
    expect(args.source).toEqual({ kind: 'file', rootId: 'root-cec43', path: 'deck.md' });
    expect(args.targets).toEqual([{ format: 'pptx' }]);
    expect(args.autoTemplates).toBe(true);
    // A declared string stays a string even though it could look like an id.
    expect(args.themeId).toBe('minimalist');
    expect(repaired.sort()).toEqual(['autoTemplates', 'source', 'targets']);
  });

  it('never reinterprets a string the schema actually declares as a string', () => {
    // The regression this guards: `write_file` shipping a JSON document.
    // Blind "parse anything that starts with a brace" corrupts it into an
    // object and the file is written wrong (or the call fails).
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    };
    const input = { path: 'tsconfig.json', content: '{"compilerOptions":{"strict":true}}' };
    const { args, repaired } = coerceArgsToSchema(input, schema);
    expect(repaired).toEqual([]);
    expect(args).toBe(input);
    expect(args.content).toBe('{"compilerOptions":{"strict":true}}');
  });

  it('leaves a union that also accepts a string alone', () => {
    const schema = {
      type: 'object',
      properties: { ref: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
    };
    const { args, repaired } = coerceArgsToSchema({ ref: '{"id":1}' }, schema);
    expect(repaired).toEqual([]);
    expect(args.ref).toBe('{"id":1}');
  });

  it('repairs nested and array-element values too', () => {
    const { args, repaired } = coerceArgsToSchema(
      { source: { kind: 'file', path: 'deck.md' }, targets: ['{"format":"pptx"}'] },
      CONVERT_SCHEMA,
    );
    expect(args.targets).toEqual([{ format: 'pptx' }]);
    expect(repaired).toEqual(['targets.0']);
  });

  it('follows local $ref so hoisted zod sub-schemas still coerce', () => {
    const schema = {
      type: 'object',
      properties: { destination: { $ref: '#/$defs/Dest' } },
      $defs: { Dest: { type: 'object', properties: { rootId: { type: 'string' } } } },
    };
    const { args, repaired } = coerceArgsToSchema(
      { destination: '{"rootId":"root-9cc18"}' },
      schema,
    );
    expect(args.destination).toEqual({ rootId: 'root-9cc18' });
    expect(repaired).toEqual(['destination']);
  });

  it('leaves prose in a structural slot alone so the validator can explain it', () => {
    const { args, repaired } = coerceArgsToSchema({ source: 'the deck file' }, CONVERT_SCHEMA);
    expect(repaired).toEqual([]);
    expect(args.source).toBe('the deck file');
  });

  it('is idempotent — repairing already-correct args changes nothing', () => {
    const good = { source: { kind: 'file', path: 'deck.md' }, targets: [{ format: 'pptx' }] };
    const { args, repaired } = coerceArgsToSchema(good, CONVERT_SCHEMA);
    expect(repaired).toEqual([]);
    expect(args).toBe(good);
  });

  it('does nothing without a schema', () => {
    const input = { source: '{"kind":"file"}' };
    expect(coerceArgsToSchema(input, undefined)).toEqual({ args: input, repaired: [] });
  });
});

describe('coerceToolCallArgs', () => {
  it('repairs the JSON-string arguments carried on salvaged tool calls', () => {
    const calls = [
      {
        id: 'hermes-repair-1',
        function: {
          name: 'convert_document',
          arguments: JSON.stringify({
            source: '{"kind":"file","path":"deck.md"}',
            targets: '[{"format":"pptx"}]',
          }),
        },
      },
    ];
    const { calls: out, repaired } = coerceToolCallArgs(calls, () => CONVERT_SCHEMA);
    expect(repaired).toEqual([{ name: 'convert_document', paths: ['source', 'targets'] }]);
    expect(JSON.parse(out[0]!.function.arguments)).toEqual({
      source: { kind: 'file', path: 'deck.md' },
      targets: [{ format: 'pptx' }],
    });
    // Untouched inputs are returned by identity so callers can skip work.
    expect(out[0]).not.toBe(calls[0]);
  });

  it('returns the same array when no call needs repair', () => {
    const calls = [{ function: { name: 'x', arguments: '{"a":1}' } }];
    const { calls: out, repaired } = coerceToolCallArgs(calls, () => undefined);
    expect(repaired).toEqual([]);
    expect(out).toBe(calls);
  });

  it('passes unparseable arguments through untouched', () => {
    const calls = [{ function: { name: 'convert_document', arguments: '{not json' } }];
    const { calls: out, repaired } = coerceToolCallArgs(calls, () => CONVERT_SCHEMA);
    expect(repaired).toEqual([]);
    expect(out).toBe(calls);
  });
});

describe('salvage → coercion (the wild failure)', () => {
  it('recovers a DocBlocks convert_document call from Hermes markup', () => {
    // qwen3.6-27b-q8 on MLX, task default/3 step `publish`. The markup
    // below is the only shape the tool grammar allowed it to emit; the
    // salvage layer turned `source`/`targets` into strings and the
    // validator rejected the call 19 times in a row with
    // "Wrong type: `source` (got string, expected object), `targets`
    // (got string, expected array)".
    const markup = [
      '<tool_call>',
      '<function=convert_document>',
      '<parameter=source>{"kind":"file","rootId":"root-cec43eb60f9f9d94","path":"deck.md"}</parameter>',
      '<parameter=targets>[{"format":"pptx","fidelity":"editable-native","slideBreak":"h1"}]</parameter>',
      '<parameter=themeId>minimalist</parameter>',
      '<parameter=autoTemplates>true</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');

    const spans = findHermesFunctionToolCallSpans(markup, new Set(['convert_document']));
    expect(spans).toHaveLength(1);
    // Salvage alone still hands over strings — that part is inherent to
    // the markup and is not what we changed.
    expect(typeof spans[0]!.arguments.source).toBe('string');

    const { args } = coerceArgsToSchema(spans[0]!.arguments, CONVERT_SCHEMA);
    expect(args).toEqual({
      source: { kind: 'file', rootId: 'root-cec43eb60f9f9d94', path: 'deck.md' },
      targets: [{ format: 'pptx', fidelity: 'editable-native', slideBreak: 'h1' }],
      themeId: 'minimalist',
      autoTemplates: true,
    });
  });

  it('leaves a write_file call carrying JSON content untouched through the same path', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    };
    const markup = [
      '<function=write_file>',
      '<parameter=path>package.json</parameter>',
      '<parameter=content>{"name":"demo","version":"1.0.0"}</parameter>',
      '</function>',
    ].join('\n');
    const spans = findHermesFunctionToolCallSpans(markup, new Set(['write_file']));
    const { args, repaired } = coerceArgsToSchema(spans[0]!.arguments, schema);
    expect(repaired).toEqual([]);
    expect(args.content).toBe('{"name":"demo","version":"1.0.0"}');
  });
});

describe('looksLikeFlattenedStructuralArg', () => {
  it('recognizes the transport-flattening signature', () => {
    const args = { source: '{"kind":"file"}', targets: '[{"format":"pptx"}]' };
    expect(looksLikeFlattenedStructuralArg(args, ['source'], 'object')).toBe(true);
    expect(looksLikeFlattenedStructuralArg(args, ['targets'], 'array')).toBe(true);
  });

  it('does not fire for a model that genuinely sent the wrong thing', () => {
    expect(looksLikeFlattenedStructuralArg({ source: 'deck.md' }, ['source'], 'object')).toBe(
      false,
    );
    // Right JSON, wrong shape — an array where an object was wanted is a
    // real model error, not a transport artifact.
    expect(looksLikeFlattenedStructuralArg({ source: '[1,2]' }, ['source'], 'object')).toBe(false);
    expect(looksLikeFlattenedStructuralArg({ n: '5' }, ['n'], 'number')).toBe(false);
    expect(looksLikeFlattenedStructuralArg({}, [], 'object')).toBe(false);
  });
});
