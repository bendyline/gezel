import { describe, expect, it } from 'vitest';
import type { McpToolWrapperContext } from './types.js';
import { ZodErrorTranslator } from './zod-error-translator.js';

const ctx: McpToolWrapperContext = {
  spec: { command: 'node', args: ['gezel-mcp'], env: {} },
  cwd: '/tmp',
  modelTier: 'tiny',
  isMeester: false,
  hasTool: () => true,
  callTool: async () => ({ text: '', images: [] }),
};

describe('ZodErrorTranslator', () => {
  it('matches every server (universal wrapper)', () => {
    expect(ZodErrorTranslator.matches({ command: 'x', args: [], env: {} })).toBe(true);
  });

  it('translates the verbatim create_project missing-field blob from the wild', async () => {
    const raw = `MCP error -32602: Input validation error: Invalid arguments for tool create_project: [
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": [
      "about"
    ],
    "message": "Required"
  },
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": [
      "missionObjectives"
    ],
    "message": "Required"
  }
]`;
    const out = await ZodErrorTranslator.postProcessError!(
      'create_project',
      { name: 'Spacewar' },
      raw,
      ctx,
    );
    expect(out).toContain('`create_project` rejected');
    expect(out).toContain('Missing required fields');
    expect(out).toContain('`about`');
    expect(out).toContain('`missionObjectives`');
    expect(out).toContain('Retry');
    // Original Zod blob should NOT survive in the translation.
    expect(out).not.toContain('"code": "invalid_type"');
  });

  it('flags too_short separately from missing', async () => {
    const raw = `Invalid arguments for tool create_project: [
  {"code":"too_small","minimum":60,"path":["about"],"message":"String must contain at least 60 character(s)"}
]`;
    const out = await ZodErrorTranslator.postProcessError!(
      'create_project',
      { name: 'X', about: 'too short' },
      raw,
      ctx,
    );
    expect(out).toContain('Too short');
    expect(out).toContain('`about`');
    expect(out).not.toContain('Missing required');
  });

  it('flags wrong-type with expected vs received', async () => {
    const raw = `Invalid arguments for tool create_task: [
  {"code":"invalid_type","expected":"string","received":"number","path":["title"],"message":"Expected string, received number"}
]`;
    const out = await ZodErrorTranslator.postProcessError!('create_task', { title: 42 }, raw, ctx);
    expect(out).toContain('Wrong type');
    expect(out).toContain('`title`');
    expect(out).toContain('got number');
    expect(out).toContain('expected string');
  });

  it('recognizes Zod 4 missing fields when received is only present in the message', async () => {
    const raw = `Invalid arguments for tool create_task: [
  {"expected":"string","code":"invalid_type","path":["title"],"message":"Invalid input: expected string, received undefined"},
  {"expected":"string","code":"invalid_type","path":["description"],"message":"Invalid input: expected string, received undefined"}
]`;
    const out = await ZodErrorTranslator.postProcessError!('create_task', {}, raw, ctx);
    expect(out).toContain('Missing required fields');
    expect(out).toContain('`title`');
    expect(out).toContain('`description`');
    expect(out).not.toContain('got unknown');
  });

  it('redirects impossible draft status changes toward plan gate authoring', async () => {
    const raw = `Invalid arguments for tool set_task_status: [
  {"received":"draft","code":"invalid_enum_value","options":["paused","active","complete","canceled"],"path":["status"],"message":"Invalid enum value. Expected 'paused' | 'active' | 'complete' | 'canceled', received 'draft'"}
]`;
    const out = await ZodErrorTranslator.postProcessError!(
      'set_task_status',
      { ref: 'plan-eval/1', status: 'draft' },
      raw,
      ctx,
    );

    expect(out).toContain('cannot set a task to `draft`');
    expect(out).toContain('Do not retry `set_task_status`');
    expect(out).toContain('set_step_deliverable');
    expect(out).toContain('activate_task');
    expect(out).not.toContain('call `set_task_status` again');
  });

  it('passes through unrelated errors unchanged', async () => {
    const raw = 'Connection refused to upstream API';
    const out = await ZodErrorTranslator.postProcessError!('create_project', {}, raw, ctx);
    expect(out).toBe(raw);
  });

  it('passes through non-JSON validator-shaped errors unchanged', async () => {
    const raw = 'Invalid arguments for tool create_project: not actually JSON';
    const out = await ZodErrorTranslator.postProcessError!('create_project', {}, raw, ctx);
    expect(out).toBe(raw);
  });

  // The verbatim failure from the wild: DocBlocks `convert_document` on
  // qwen3.6-27b via MLX. The model's JSON was correct; the Hermes markup
  // it had to emit flattened `source`/`targets` into strings. The generic
  // "retry with corrected args" tail turned that into 19 consecutive
  // identical attempts before the gezel gave up and shipped a stale file.
  const FLATTENED_RAW = `MCP error -32602: Input validation error: Invalid arguments for tool convert_document: [
  {"code":"invalid_type","expected":"object","received":"string","path":["source"],"message":"Expected object, received string"},
  {"code":"invalid_type","expected":"array","received":"string","path":["targets"],"message":"Expected array, received string"}
]`;

  it('tells the model the transport flattened its args, not that it got them wrong', async () => {
    const out = await ZodErrorTranslator.postProcessError!(
      'convert_document',
      {
        source: '{"kind":"file","rootId":"root-cec43","path":"deck.md"}',
        targets: '[{"format":"pptx","fidelity":"editable-native"}]',
      },
      FLATTENED_RAW,
      ctx,
    );
    expect(out).toContain('`source`');
    expect(out).toContain('`targets`');
    expect(out).toContain('JSON text instead of a real object/array');
    expect(out).toContain('cannot carry nested structure');
    expect(out).toContain('structured tool call');
    // The loop generator must be gone: never invite the identical retry.
    expect(out).not.toContain('again with corrected args');
  });

  it('still gives ordinary wrong-type guidance when the value is not flattened JSON', async () => {
    const out = await ZodErrorTranslator.postProcessError!(
      'convert_document',
      { source: 'deck.md', targets: 'pptx' },
      FLATTENED_RAW,
      ctx,
    );
    expect(out).toContain('Wrong type');
    expect(out).toContain('Retry `convert_document` with the corrections named above');
    expect(out).not.toContain('cannot carry nested structure');
  });

  it('handles nested paths', async () => {
    const raw = `Invalid arguments for tool create_task: [
  {"code":"invalid_type","expected":"string","received":"undefined","path":["assignee","gezelId"],"message":"Required"}
]`;
    const out = await ZodErrorTranslator.postProcessError!('create_task', {}, raw, ctx);
    expect(out).toContain('`assignee.gezelId`');
  });
});

/**
 * The verbatim DocBlocks `preview_document` input schema, trimmed to the
 * `source` union. Real shape, not a hand-drawn approximation: the branch
 * order, the `const` discriminators, the `additionalProperties: false`,
 * and the artifact-uri `pattern` are all what the server publishes.
 */
const PREVIEW_DOCUMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    source: {
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'markdown' },
            markdown: { type: 'string', maxLength: 20971520 },
            name: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
          },
          required: ['kind', 'markdown'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'file' },
            rootId: { type: 'string', minLength: 1, maxLength: 256 },
            path: { type: 'string', minLength: 1, maxLength: 4096 },
            format: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
          },
          required: ['kind', 'rootId', 'path'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'artifact' },
            uri: {
              type: 'string',
              maxLength: 278,
              pattern: '^docblocks://artifacts/[A-Za-z0-9][A-Za-z0-9._:-]*$',
            },
          },
          required: ['kind', 'uri'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'bundle' },
            markdown: { type: 'string' },
            assets: { type: 'array', items: { type: 'object' } },
          },
          required: ['kind', 'markdown', 'assets'],
          additionalProperties: false,
        },
      ],
    },
    maxItems: { type: 'integer', minimum: 1, maximum: 20 },
  },
  required: ['source'],
  additionalProperties: false,
};

const ARTIFACT_URI = 'docblocks://artifacts/2995b61b-e2e4-4ff8-8463-905d03cad5e3';

/**
 * Task default/8, gemma4-e4b-q4 on llama-cpp. The publish step said
 * "call `preview_document` on the PPTX artifact URI", so the model passed
 * the URI; the reply named a type and no fields; it guessed an object,
 * then regressed to the string and gave up. Every message below is the
 * one that would have unblocked the attempt that produced it.
 */
describe('ZodErrorTranslator schema-derived shape hints', () => {
  const WRONG_TYPE_RAW = `MCP error -32602: Input validation error: Invalid arguments for tool preview_document: [
  {"code":"invalid_type","expected":"object","received":"string","path":["source"],"message":"Expected object, received string"}
]`;

  it('names every accepted object shape when a scalar lands in an object slot', async () => {
    const out = await ZodErrorTranslator.postProcessError!(
      'preview_document',
      { source: ARTIFACT_URI },
      WRONG_TYPE_RAW,
      ctx,
      PREVIEW_DOCUMENT_SCHEMA,
    );
    expect(out).toContain('Wrong type');
    expect(out).toContain('"kind": "markdown"');
    expect(out).toContain('"kind": "file", "rootId": …, "path": …');
    expect(out).toContain('"kind": "artifact", "uri": …');
    // Optional fields stay out of the hint — `format` and `name` are not
    // needed to get the next call accepted.
    expect(out).not.toContain('"format"');
    expect(out).not.toContain('"name"');
  });

  it('routes the scalar into the one branch whose pattern accepts it', async () => {
    const out = await ZodErrorTranslator.postProcessError!(
      'preview_document',
      { source: ARTIFACT_URI },
      WRONG_TYPE_RAW,
      ctx,
      PREVIEW_DOCUMENT_SCHEMA,
    );
    expect(out).toContain('belongs in `uri`');
    expect(out).toContain(`{ "kind": "artifact", "uri": "${ARTIFACT_URI}" }`);
  });

  it('does not invent a branch when the scalar matches no pattern', async () => {
    const out = await ZodErrorTranslator.postProcessError!(
      'preview_document',
      { source: 'deck.md' },
      WRONG_TYPE_RAW,
      ctx,
      PREVIEW_DOCUMENT_SCHEMA,
    );
    expect(out).toContain('must be an object in one of these shapes');
    expect(out).not.toContain('belongs in');
  });

  it('keeps the plain wrong-type message when no schema is available', async () => {
    const out = await ZodErrorTranslator.postProcessError!(
      'preview_document',
      { source: ARTIFACT_URI },
      WRONG_TYPE_RAW,
      ctx,
    );
    expect(out).toContain('Wrong type');
    expect(out).not.toContain('object in one of these shapes');
  });

  const DISCRIMINATOR_RAW = `MCP error -32602: Input validation error: Invalid arguments for tool preview_document: [
  {"code":"invalid_union_discriminator","options":["markdown","file","artifact","bundle"],"path":["source","kind"],"message":"Invalid discriminator value. Expected 'markdown' | 'file' | 'artifact' | 'bundle'"}
]`;

  it('names the closest branch and the exact edits for a discriminator miss', async () => {
    // Attempt 2 from the wild: `uri` right, `kind` missing, `format`
    // fatal under additionalProperties:false.
    const out = await ZodErrorTranslator.postProcessError!(
      'preview_document',
      { source: { format: 'pptx', uri: ARTIFACT_URI } },
      DISCRIMINATOR_RAW,
      ctx,
      PREVIEW_DOCUMENT_SCHEMA,
    );
    expect(out).toContain('Invalid discriminator value');
    expect(out).toContain('Closest shape for what you sent is `{ "kind": "artifact", "uri": … }`');
    expect(out).toContain('set `kind: "artifact"`');
    expect(out).toContain('remove `format` (not allowed in this shape)');
  });

  it('stays silent when the args resemble no branch at all', async () => {
    const out = await ZodErrorTranslator.postProcessError!(
      'preview_document',
      { source: { wholly: 'unrelated' } },
      DISCRIMINATOR_RAW,
      ctx,
      PREVIEW_DOCUMENT_SCHEMA,
    );
    expect(out).toContain('Invalid discriminator value');
    expect(out).not.toContain('Closest shape');
  });

  it('leaves the flattened-transport verdict alone rather than adding shape noise', async () => {
    const out = await ZodErrorTranslator.postProcessError!(
      'preview_document',
      { source: `{"kind":"artifact","uri":"${ARTIFACT_URI}"}` },
      WRONG_TYPE_RAW,
      ctx,
      PREVIEW_DOCUMENT_SCHEMA,
    );
    expect(out).toContain('cannot carry nested structure');
    expect(out).not.toContain('must be an object in one of these shapes');
  });
});
