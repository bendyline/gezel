import { describe, expect, it } from 'vitest';
import type { OpenAIFunctionTool } from '../../providers/mcp-bridge.js';
import { McpCompactToolSchemas } from './mcp-compact-tool-schemas.js';

// The expectedDeliverable.checks oneOf was the single heaviest structure on
// the tool wire: ~7.1K chars stamped into all 13 delegation tools = ~54% of
// the compacted surface. The slim keeps full variants for the kinds models
// actually author inline (census 2026-08-03: sniff/contains/minBytes/chat =
// 84% of usage) and folds the tail into one variant that still NAMES every
// kind — wire schemas are advisory, so exotic craftbook gates stay emittable.

function delegateTool(): OpenAIFunctionTool {
  const variant = (kind: string, extra: Record<string, unknown> = {}) => ({
    type: 'object',
    properties: {
      kind: { const: kind },
      file: { type: 'string', description: `the file this ${kind} check reads` },
      ...extra,
    },
    required: ['kind', 'file'],
  });
  return {
    type: 'function',
    name: 'delegate_developer',
    description: 'Delegate work to a developer gezel.',
    parameters: {
      type: 'object',
      properties: {
        expectedDeliverable: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            filePath: { type: 'string' },
            checks: {
              type: 'array',
              items: {
                oneOf: [
                  variant('sniff', { sniff: { type: 'string' } }),
                  variant('contains', { text: { type: 'string' } }),
                  variant('minBytes', { bytes: { type: 'number' } }),
                  variant('chat'),
                  variant('nodeRuns', { script: { type: 'string' } }),
                  variant('jsonPathEquals', { path: { type: 'string' }, value: {} }),
                  variant('testPasses', { command: { type: 'string' } }),
                ],
              },
            },
          },
        },
      },
    },
  };
}

function decorate(tool: OpenAIFunctionTool): OpenAIFunctionTool {
  const wrapper = McpCompactToolSchemas.mcpWrapper!();
  return wrapper.decorateTools!([tool], { modelTier: 'medium' } as never)[0]!;
}

function checksUnion(tool: OpenAIFunctionTool): Array<Record<string, unknown>> {
  const ed = (tool.parameters.properties as Record<string, unknown>)
    .expectedDeliverable as Record<string, unknown>;
  const checks = (ed.properties as Record<string, unknown>).checks as Record<string, unknown>;
  return (checks.items as Record<string, unknown>).oneOf as Array<Record<string, unknown>>;
}

describe('compact-tool-schemas checks-union slim', () => {
  it('keeps full variants for the head kinds and folds the tail into one', () => {
    const out = decorate(delegateTool());
    const union = checksUnion(out);
    // 4 head kinds + 1 folded tail variant.
    expect(union).toHaveLength(5);
    const kinds = union
      .map((v) => ((v.properties as Record<string, unknown>).kind as Record<string, unknown>))
      .map((k) => k.const ?? k.enum);
    expect(kinds.slice(0, 4)).toEqual(['sniff', 'contains', 'minBytes', 'chat']);
    // The folded variant names every tail kind so they stay emittable.
    expect(kinds[4]).toEqual(['nodeRuns', 'jsonPathEquals', 'testPasses']);
  });

  it('shrinks the delegate tool by more than half', () => {
    const raw = delegateTool();
    const out = decorate(structuredClone(raw));
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(raw).length * 0.7);
  });

  it('leaves small unions untouched', () => {
    const tool = delegateTool();
    const ed = (tool.parameters.properties as Record<string, unknown>)
      .expectedDeliverable as Record<string, unknown>;
    const checks = (ed.properties as Record<string, unknown>).checks as Record<string, unknown>;
    (checks.items as Record<string, unknown>).oneOf = [
      { type: 'object', properties: { kind: { const: 'sniff' } } },
    ];
    const out = decorate(tool);
    expect(checksUnion(out)).toHaveLength(1);
  });
});
