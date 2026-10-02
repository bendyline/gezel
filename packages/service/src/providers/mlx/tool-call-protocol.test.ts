import { describe, expect, it } from 'vitest';
import type { McpBridgePool } from '../mcp-bridge-pool.js';
import {
  type ChatCompletionTool,
  applyCallableToolGrammar,
  callableRequestToolNames,
} from './tool-call-protocol.js';

function tool(name: string): ChatCompletionTool {
  return { type: 'function', function: { name, description: '', parameters: {} } };
}

function bridges(restricted: readonly string[] | null): McpBridgePool {
  return {
    hasCallableRestriction: () => restricted !== null,
    isRestrictedFromCalling: (name: string) => restricted?.includes(name) ?? false,
  } as unknown as McpBridgePool;
}

describe('callable tool grammar', () => {
  const tools = [tool('start_project'), tool('write_artifact'), tool('external_lookup')];

  it('narrows the grammar hint and leaves the advertised tools untouched', () => {
    const body: Record<string, unknown> = {
      tools,
      tool_grammar: { format: 'gemma', mode: 'name-only' },
    };
    applyCallableToolGrammar(body, bridges(['write_artifact']));
    expect(body.tools).toBe(tools);
    expect(body.tool_grammar).toEqual({
      format: 'gemma',
      mode: 'name-only',
      allowed_names: ['start_project', 'external_lookup'],
    });
  });

  it('sends no allowed_names without a restriction or a grammar', () => {
    const open: Record<string, unknown> = { tools, tool_grammar: { format: 'gemma' } };
    applyCallableToolGrammar(open, bridges(null));
    expect(open.tool_grammar).toEqual({ format: 'gemma' });

    const ungrammared: Record<string, unknown> = { tools };
    applyCallableToolGrammar(ungrammared, bridges(['write_artifact']));
    expect(ungrammared.tool_grammar).toBeUndefined();
  });

  it('lists the callable names for a refusal message', () => {
    expect(callableRequestToolNames(tools, bridges(['write_artifact']))).toEqual([
      'start_project',
      'external_lookup',
    ]);
  });
});
