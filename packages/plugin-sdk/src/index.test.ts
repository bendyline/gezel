import { describe, expect, it } from 'vitest';
import {
  PluginManifestSchema,
  PluginRequestSchema,
  PluginResponseSchema,
  fail,
  ok,
} from './index.js';

describe('PluginManifestSchema', () => {
  it('parses a valid manifest', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'hello',
      description: 'A test plugin',
      entry: './dist/plugin.js',
      tools: [{ name: 'greet', description: 'Say hello' }],
    });
    expect(manifest.name).toBe('hello');
    expect(manifest.tools).toHaveLength(1);
  });

  it('defaults tools to empty array', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'minimal',
      entry: './index.js',
    });
    expect(manifest.tools).toEqual([]);
  });
});

describe('PluginRequestSchema', () => {
  it('parses a tool invocation', () => {
    const req = PluginRequestSchema.parse({ tool: 'greet', input: { name: 'World' } });
    expect(req.tool).toBe('greet');
  });
});

describe('ok / fail helpers', () => {
  it('ok returns success response', () => {
    const res = ok({ greeting: 'hello' });
    expect(res.ok).toBe(true);
    expect(PluginResponseSchema.parse(res).output).toEqual({ greeting: 'hello' });
  });

  it('fail returns error response', () => {
    const res = fail('something broke');
    expect(res.ok).toBe(false);
    expect(PluginResponseSchema.parse(res).error).toBe('something broke');
  });
});
