import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModelProfile } from '../../model-profile/types.js';
import type { LLMSession } from '../types.js';
import { MlxProvider } from './provider.js';

// A coordinator routing clamp keeps every tool advertised (the rendered
// prompt must not change, or an untrimmable cache re-prefills from the
// divergence) and confines calls instead: the grammar for native calls, the
// dispatch guard for calls salvaged from text.

const profile = {
  catalogId: 'qwen-test',
  tier: 'medium',
  style: { family: 'qwen', reasoningFormat: 'think', toolCallFormat: 'function-call' },
  behaviors: [{ id: 'tools.mlx-grammar', config: undefined, behavior: {} as never }],
} as ResolvedModelProfile;

const CALL =
  '<tool_call>\n{"name": "write_artifact", "arguments": {"path": "plan.md", "content": "x"}}\n</tool_call>';

function reply(content: string): Response {
  const frame = { choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function tool(name: string) {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  };
}

const sessions: LLMSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

describe('MLX callable tool restriction', () => {
  it('narrows only the grammar and refuses a salvaged call outside it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? reply(CALL) : reply('The lead is on it.');
    });
    const provider = new MlxProvider({
      baseUrl: 'http://engine.test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const session = await provider.createSession({ systemMessage: 'system', profile });
    sessions.push(session);
    const callTool = vi.fn(async () => 'ok');
    (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [tool('start_project'), tool('write_artifact')],
      hasTool: (name: string) => name === 'start_project',
      hasCallableRestriction: () => true,
      isRestrictedFromCalling: (name: string) => name === 'write_artifact',
      callTool,
      stop: async () => {},
    };

    await session.sendAndWait('Can we build a tank combat game?');

    const first = bodies[0]!;
    expect(
      (first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
    ).toEqual(['start_project', 'write_artifact']);
    expect(first.tool_grammar).toMatchObject({
      format: 'hermes',
      allowed_names: ['start_project'],
    });
    expect(callTool).not.toHaveBeenCalled();
    const toolResult = (bodies[1]!.messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'tool',
    );
    expect(toolResult?.content).toContain('`write_artifact` is not available for this request');
    expect(toolResult?.content).toContain('`start_project`');
  });
});
