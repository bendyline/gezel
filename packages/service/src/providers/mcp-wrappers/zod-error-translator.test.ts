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

  it('handles nested paths', async () => {
    const raw = `Invalid arguments for tool create_task: [
  {"code":"invalid_type","expected":"string","received":"undefined","path":["assignee","gezelId"],"message":"Required"}
]`;
    const out = await ZodErrorTranslator.postProcessError!('create_task', {}, raw, ctx);
    expect(out).toContain('`assignee.gezelId`');
  });
});
