import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../schemas/gezel.js';
import { resolveTuning } from '../tuning-resolve.js';
import { PortableEngineHost } from './local-loop-host.js';
import type { PortableInference } from './product-service.js';
import { type PortableToolActions, portableToolSurface } from './product-tools.js';
import { runSharedLoopTurn } from './shared-loop-turn.js';
import { portableFixture } from './test-files.js';

const actions: PortableToolActions = {
  recruit: async () => {
    throw new Error('unexpected recruitment');
  },
  templates: () => [],
  createTask: async () => {},
  completeTask: async () => {},
  assertHandoffAllowed: () => {},
  message: async () => {},
  startProject: async () => {},
};

type Chat = NonNullable<PortableInference['chat']>;
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});
/** Native chunks arrive over time, after the loop's reader has locked the stream. */
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

async function turn(chat: Chat, opts: { cancelled?: () => boolean } = {}) {
  const { store } = portableFixture();
  await store.ensureLayout();
  const gezel = await store.createGezel({ name: 'Loop tester', role: 'Helper' });
  const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
  await store.writeFile('workspace', session.projectId, 'brief.md', '# Repair day\n');
  const tools = await portableToolSurface(store, session);
  const checkpoints: ChatMessage[] = [];
  const deltas: string[] = [];
  const result = await runSharedLoopTurn({
    store,
    inference: { providers: async () => [], generate: vi.fn(), chat, cancel: async () => {} },
    host: new PortableEngineHost(),
    session,
    requestId: 'req-1',
    modelId: 'model',
    contextSize: 16384,
    structuredChat: {
      config: { reasoning_budget: 2048 },
      tuning: resolveTuning({
        catalog: {
          sampling: { temperature: 0.3, topK: 40 },
          reasoning: { enableThinking: true, thinkingBudget: 2048 },
        },
      }),
    },
    isMeester: false,
    systemMessage: 'You help with repair days.',
    history: [],
    prompt: 'What does brief.md say?',
    tools,
    actions,
    signal: new AbortController().signal,
    cancelled: opts.cancelled ?? (() => false),
    checkpoint: async (message) => {
      checkpoints.push(structuredClone(message));
    },
    tool: () => {},
    delta: (text) => deltas.push(text),
  });
  return { result, checkpoints, deltas };
}

describe('the desktop llama.cpp loop on a phone engine', () => {
  it('sends the desktop request, runs tool calls durably, and replies', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const configs: unknown[] = [];
    const chat = vi.fn<Chat>(async (request, onChunk) => {
      bodies.push(structuredClone(request.body));
      configs.push(request.chatConfig);
      if (bodies.length === 1) {
        onChunk(chunk({ role: 'assistant', content: null }));
        await later();
        onChunk(chunk({ reasoning_content: 'Read the brief first.' }));
        await later();
        onChunk(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call-a',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"brief.md"}' },
              },
            ],
          }),
        );
        await later();
        onChunk(chunk({}, 'tool_calls'));
      } else {
        onChunk(chunk({ content: 'It announces' }));
        await later();
        onChunk(chunk({ content: ' the repair day.' }));
        await later();
        onChunk(chunk({}, 'stop'));
      }
      await later();
      return { status: 'ok' };
    });
    const { result, checkpoints, deltas } = await turn(chat);
    expect(result.text).toBe('It announces the repair day.');
    expect(deltas.join('')).toContain('It announces the repair day.');
    expect(result.message?.toolCalls?.[0]).toMatchObject({ name: 'read_file', success: true });
    // The started record is durable before the effect runs.
    expect(checkpoints[0]?.toolCalls?.[0]).toMatchObject({ name: 'read_file', success: false });
    const [first, second] = bodies;
    expect(first).toMatchObject({
      stream: true,
      temperature: 0.3,
      top_k: 40,
      reasoning_budget_tokens: 2048,
      chat_template_kwargs: { enable_thinking: true },
    });
    expect(
      (first!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
    ).toContain('read_file');
    expect(configs[0]).toEqual({ reasoning_budget: 2048 });
    const messages = second!.messages as Array<Record<string, unknown>>;
    expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-a' });
    // The desktop's words for the result: a numbered file, trimmed as the bridge trims.
    expect(messages.at(-1)!.content).toBe('1→# Repair day');
  });

  it('shows the reason the engine gives when it refuses to start a request', async () => {
    const chat = vi.fn<Chat>(async () => {
      throw new Error('This device is too warm to run a model. Let it cool before trying again.');
    });
    await expect(turn(chat)).rejects.toThrow(
      /^This device is too warm to run a model\. Let it cool before trying again\.$/,
    );
  });

  it('answers llama-server context errors the way llama-server does', async () => {
    const chat = vi.fn<Chat>(async (_request, onChunk) => {
      onChunk({
        error: {
          code: 400,
          message:
            'request (20000 tokens) exceeds the available context size (16384 tokens), try increasing it',
          type: 'exceed_context_size_error',
          n_prompt_tokens: 20000,
          n_ctx: 16384,
        },
      });
      return { status: 'error' };
    });
    await expect(turn(chat)).rejects.toThrow(
      /ran out of working memory: 20,000 tokens needed but only 16,384 available/,
    );
  });
});
