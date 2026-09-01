import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicSession, type AnthropicSessionDeps } from './anthropic.js';
import { McpBridgePool } from './mcp-bridge-pool.js';
import { ProviderQueue } from './queue.js';
import type { ExternalToolSpec } from './types.js';

/**
 * Stub the Anthropic SDK so the session test can script a stream of
 * events without spinning up a real client. `onRequest` records the
 * request payload — tests assert on `messages`, `tools`, etc.
 */
function stubAnthropic(events: unknown[], onRequest?: (req: unknown) => void): Anthropic {
  return {
    messages: {
      create: async (req: unknown) => {
        onRequest?.(req);
        return (async function* () {
          for (const ev of events) yield ev;
        })() as AsyncIterable<unknown>;
      },
    },
  } as unknown as Anthropic;
}

function stubAnthropicTurns(turns: unknown[][], onRequest?: (req: unknown) => void): Anthropic {
  let turn = 0;
  return {
    messages: {
      create: async (req: unknown) => {
        onRequest?.(req);
        const events = turns[turn++] ?? [];
        return (async function* () {
          for (const ev of events) yield ev;
        })() as AsyncIterable<unknown>;
      },
    },
  } as unknown as Anthropic;
}

async function emptyBridge(): Promise<McpBridgePool> {
  return McpBridgePool.fromSessionOpts({ systemMessage: '' }, '[test]');
}

function makeSession(
  events: unknown[],
  overrides: Partial<AnthropicSessionDeps> = {},
  onRequest?: (req: unknown) => void,
): Promise<AnthropicSession> {
  return (async () => {
    const bridges = await emptyBridge();
    return new AnthropicSession({
      anthropic: stubAnthropic(events, onRequest),
      model: 'claude-test',
      systemMessage: 'You are a test assistant.',
      bridges,
      priorMessages: [],
      queue: new ProviderQueue({ concurrency: 1 }),
      ...overrides,
    });
  })();
}

const WEATHER_TOOL: ExternalToolSpec = {
  name: 'get_weather',
  description: 'Look up weather.',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

// Build the stream events the Anthropic SDK would produce when the
// model emits a tool_use block followed by message_stop.
function toolUseStream(blockId: string, name: string, input: object): unknown[] {
  return [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: blockId, name },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ];
}

function textStream(text: string): unknown[] {
  return [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  ];
}

describe('AnthropicSession — external tools', () => {
  it('advertises external tools in the request and captures the tool_use on halt', async () => {
    const captured: { value: { tools?: Array<{ name: string }> } | null } = { value: null };
    const session = await makeSession(
      toolUseStream('tu_1', 'get_weather', { city: 'Amsterdam' }),
      { externalTools: [WEATHER_TOOL] },
      (req) => {
        captured.value = req as { tools?: Array<{ name: string }> };
      },
    );

    const text = await session.sendAndWait('Weather in Amsterdam?');
    expect(text).toBe('');
    expect(captured.value?.tools).toBeTruthy();
    expect(captured.value?.tools?.map((t) => t.name)).toContain('get_weather');
    expect(session.getRegisteredToolNames()).toContain('get_weather');

    const calls = session.capturedToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('tu_1');
    expect(calls[0]?.name).toBe('get_weather');
    expect(JSON.parse(calls[0]?.arguments ?? '{}')).toEqual({ city: 'Amsterdam' });
  });

  it('does not loop into a second turn when external tool was called', async () => {
    let createCount = 0;
    const session = await makeSession(
      toolUseStream('tu_1', 'get_weather', { city: 'Paris' }),
      { externalTools: [WEATHER_TOOL] },
      () => {
        createCount += 1;
      },
    );
    await session.sendAndWait('Paris weather');
    expect(createCount).toBe(1);
  });

  it('returns text and leaves captures empty when the model just responds', async () => {
    const session = await makeSession(textStream('Sunny and 20C.'), {
      externalTools: [WEATHER_TOOL],
    });
    const text = await session.sendAndWait('Quick chat');
    expect(text).toBe('Sunny and 20C.');
    expect(session.capturedToolCalls()).toEqual([]);
  });
});

describe('AnthropicSession — bridge tool results', () => {
  it('propagates an in-band MCP error to Anthropic tool_result.is_error', async () => {
    const requests: unknown[] = [];
    const bridges = await emptyBridge();
    vi.spyOn(bridges, 'hasTool').mockReturnValue(true);
    const callToolRich = vi.spyOn(bridges, 'callToolRich').mockResolvedValue({
      text: 'ERROR: memory service unavailable',
      images: [],
      isError: true,
    });
    const session = new AnthropicSession({
      anthropic: stubAnthropicTurns(
        [toolUseStream('tu_error', 'save_memory', { text: 'remember this' }), textStream('Done.')],
        (request) => requests.push(request),
      ),
      model: 'claude-test',
      systemMessage: 'You are a test assistant.',
      bridges,
      priorMessages: [],
      queue: new ProviderQueue({ concurrency: 1 }),
    });

    await expect(session.sendAndWait('Remember this.')).resolves.toBe('Done.');
    expect(callToolRich).toHaveBeenCalledWith('save_memory', { text: 'remember this' });

    const secondRequest = requests[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const resultMessage = secondRequest.messages.at(-1);
    expect(resultMessage?.role).toBe('user');
    expect(resultMessage?.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'tu_error',
        content: 'ERROR: memory service unavailable',
        is_error: true,
      }),
    ]);
  });

  it('does not request another generation after advance_task_step succeeds', async () => {
    const bridges = await emptyBridge();
    vi.spyOn(bridges, 'hasTool').mockReturnValue(true);
    vi.spyOn(bridges, 'callToolRich').mockResolvedValue({
      text: 'Completed step "research" on default/10. Active step is now "outline".',
      images: [],
      isError: false,
    });
    let requestCount = 0;
    const session = new AnthropicSession({
      anthropic: stubAnthropic(
        toolUseStream('advance-1', 'advance_task_step', {
          ref: 'default/10',
          stepId: 'research',
        }),
        () => {
          requestCount += 1;
        },
      ),
      model: 'claude-test',
      systemMessage: 'You are a test assistant.',
      bridges,
      priorMessages: [],
      queue: new ProviderQueue({ concurrency: 1 }),
    });

    await expect(session.sendAndWait('Finish research.')).resolves.toBe(
      'Completed step "research" on default/10. Active step is now "outline".',
    );
    expect(requestCount).toBe(1);
  });
});

describe('AnthropicSession — thinking capture', () => {
  function thinkingThenTextStream(thinking: string, text: string): unknown[] {
    return [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
  }

  it('streams thinking as deltas, exposes it via getLastTurnReasoning, and keeps it out of the reply', async () => {
    const session = await makeSession(thinkingThenTextStream('Let me consider…', 'Answer.'));
    const streamed: string[] = [];
    session.onDelta((chunk) => streamed.push(chunk));

    const text = await session.sendAndWait('Question?');
    expect(text).toBe('Answer.');
    expect(session.getLastTurnReasoning()).toBe('Let me consider…');
    // Both the thinking and the reply streamed live, in order.
    expect(streamed).toEqual(['Let me consider…', 'Answer.']);
  });

  it('returns undefined when the turn produced no thinking', async () => {
    const session = await makeSession(textStream('Plain reply.'));
    await session.sendAndWait('Hi');
    expect(session.getLastTurnReasoning()).toBeUndefined();
  });

  it('resets the capture at the start of each turn', async () => {
    const bridges = await (async () =>
      McpBridgePool.fromSessionOpts({ systemMessage: '' }, '[test]'))();
    let call = 0;
    const anthropic = {
      messages: {
        create: async () => {
          call += 1;
          const events =
            call === 1
              ? thinkingThenTextStream('First-turn thinking.', 'First.')
              : textStream('Second.');
          return (async function* () {
            for (const ev of events) yield ev;
          })();
        },
      },
    } as never;
    const session = new AnthropicSession({
      anthropic,
      model: 'claude-test',
      systemMessage: 'You are a test assistant.',
      bridges: await bridges,
      priorMessages: [],
      queue: new ProviderQueue({ concurrency: 1 }),
    });

    await session.sendAndWait('One');
    expect(session.getLastTurnReasoning()).toBe('First-turn thinking.');
    await session.sendAndWait('Two');
    expect(session.getLastTurnReasoning()).toBeUndefined();
  });
});

describe('AnthropicSession — priorMessages translation', () => {
  it('translates an assistant tool_calls history turn into tool_use content blocks', async () => {
    const captured: {
      value: { messages?: Array<{ role: string; content: unknown }> } | null;
    } = { value: null };
    const session = await makeSession(
      textStream('continuing'),
      {
        priorMessages: [
          { role: 'user', content: 'do it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc_1', name: 'get_weather', arguments: '{"city":"Berlin"}' }],
          },
          { role: 'tool', content: '15C, cloudy', toolCallId: 'tc_1' },
        ],
        externalTools: [WEATHER_TOOL],
      },
      (req) => {
        captured.value = req as { messages?: Array<{ role: string; content: unknown }> };
      },
    );
    await session.sendAndWait('');

    const msgs = captured.value?.messages ?? [];
    expect(msgs[0]).toEqual({ role: 'user', content: 'do it' });

    const assistant = msgs[1] as { role: string; content: Array<{ type: string }> };
    expect(assistant.role).toBe('assistant');
    const toolUse = assistant.content.find((b) => b.type === 'tool_use') as unknown as {
      id: string;
      name: string;
      input: object;
    };
    expect(toolUse.id).toBe('tc_1');
    expect(toolUse.name).toBe('get_weather');
    expect(toolUse.input).toEqual({ city: 'Berlin' });

    // tool result lives on a user message as a tool_result block.
    const userToolResult = msgs[2] as { role: string; content: Array<{ type: string }> };
    expect(userToolResult.role).toBe('user');
    const block = userToolResult.content[0] as {
      type: string;
      tool_use_id: string;
      content: string;
    };
    expect(block.type).toBe('tool_result');
    expect(block.tool_use_id).toBe('tc_1');
    expect(block.content).toBe('15C, cloudy');
  });

  it('does not push an extra empty user message when the prompt is empty (tool-result continuation)', async () => {
    const captured: { value: { messages?: Array<{ role: string }> } | null } = { value: null };
    const session = await makeSession(
      textStream('done'),
      {
        priorMessages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc_x', name: 'get_weather', arguments: '{}' }],
          },
          { role: 'tool', content: 'result', toolCallId: 'tc_x' },
        ],
      },
      (req) => {
        captured.value = req as { messages?: Array<{ role: string }> };
      },
    );
    await session.sendAndWait('');
    const msgs = captured.value?.messages ?? [];
    // history is 3 entries (user, assistant, user-tool-result). With
    // empty prompt, we don't push another user message.
    expect(msgs.length).toBe(3);
  });
});
