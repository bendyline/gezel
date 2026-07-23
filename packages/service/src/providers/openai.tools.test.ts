import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { McpBridgePool } from './mcp-bridge-pool.js';
import { OpenAISession, type OpenAISessionDeps } from './openai.js';
import { ProviderQueue } from './queue.js';
import type { ExternalToolSpec } from './types.js';

/**
 * Build a stub OpenAI SDK whose `responses.stream(request)` returns the
 * supplied async iterable. Tests can record the request body via the
 * `onRequest` callback to assert that priorMessages, tools, and
 * attachments are reshaped correctly.
 */
function stubOpenAI(events: unknown[], onRequest?: (req: unknown) => void): OpenAI {
  return {
    responses: {
      stream: (req: unknown) => {
        onRequest?.(req);
        return (async function* () {
          for (const ev of events) yield ev;
        })();
      },
    },
  } as unknown as OpenAI;
}

async function emptyBridge(): Promise<McpBridgePool> {
  return McpBridgePool.fromSessionOpts({ systemMessage: '' }, '[test]');
}

function makeSession(
  events: unknown[],
  overrides: Partial<OpenAISessionDeps> = {},
  onRequest?: (req: unknown) => void,
): Promise<OpenAISession> {
  return (async () => {
    const bridges = await emptyBridge();
    return new OpenAISession({
      openai: stubOpenAI(events, onRequest),
      model: 'gpt-test',
      systemMessage: 'You are a test assistant.',
      bridges,
      previousResponseId: null,
      queue: new ProviderQueue({ concurrency: 1 }),
      ...overrides,
    });
  })();
}

function textEvent(text: string): unknown {
  return { type: 'response.output_text.delta', delta: text };
}

function functionCallItemEvent(call_id: string, name: string, args: string): unknown {
  return {
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id, name, arguments: args },
  };
}

function completedEvent(id: string): unknown {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

const WEATHER_TOOL: ExternalToolSpec = {
  name: 'get_weather',
  description: 'Look up weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

describe('OpenAISession — external tools', () => {
  it('advertises external tools in the OpenAI request and captures the call on halt', async () => {
    const recorded: unknown[] = [];
    const session = await makeSession(
      [
        textEvent('I will look that up'),
        functionCallItemEvent('call_1', 'get_weather', '{"city":"Amsterdam"}'),
        completedEvent('resp_1'),
      ],
      { externalTools: [WEATHER_TOOL] },
      (req) => recorded.push(req),
    );

    const text = await session.sendAndWait('Weather in Amsterdam?');
    expect(text).toBe('I will look that up');

    // Tools were advertised.
    const req = recorded[0] as { tools?: Array<{ name: string }> };
    expect(req.tools).toBeTruthy();
    expect(req.tools?.map((t) => t.name)).toContain('get_weather');

    // Captures surfaced for the route.
    const captured = session.capturedToolCalls();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.id).toBe('call_1');
    expect(captured[0]?.name).toBe('get_weather');
    expect(JSON.parse(captured[0]?.arguments ?? '{}')).toEqual({ city: 'Amsterdam' });
  });

  it('does not loop into a second turn when only external calls were emitted', async () => {
    let streamCount = 0;
    const session = await makeSession(
      [
        functionCallItemEvent('call_a', 'get_weather', '{"city":"Berlin"}'),
        completedEvent('resp_2'),
      ],
      { externalTools: [WEATHER_TOOL] },
      () => {
        streamCount += 1;
      },
    );

    await session.sendAndWait('Berlin');
    expect(streamCount).toBe(1);
    expect(session.capturedToolCalls()).toHaveLength(1);
  });

  it('returns text normally and leaves captures empty when no external tool is called', async () => {
    const session = await makeSession([textEvent('plain reply'), completedEvent('resp_3')], {
      externalTools: [WEATHER_TOOL],
    });

    const text = await session.sendAndWait('Hi');
    expect(text).toBe('plain reply');
    expect(session.capturedToolCalls()).toEqual([]);
  });
});

describe('OpenAISession — priorMessages → Responses input', () => {
  it('threads user + assistant text turns into the input array on the first turn', async () => {
    const captured: { value: { input?: unknown } | null } = { value: null };
    const session = await makeSession(
      [textEvent('ack'), completedEvent('resp_4')],
      {
        priorMessages: [
          { role: 'user', content: 'turn 1' },
          { role: 'assistant', content: 'reply 1' },
        ],
      },
      (req) => {
        captured.value = req as { input?: unknown };
      },
    );
    await session.sendAndWait('turn 2');
    const items = captured.value?.input as Array<{ role?: string; content?: string }>;
    expect(items[0]).toEqual({ role: 'user', content: 'turn 1' });
    expect(items[1]).toEqual({ role: 'assistant', content: 'reply 1' });
    expect(items[2]).toEqual({ role: 'user', content: 'turn 2' });
  });

  it('translates an assistant tool_calls history turn into Responses function_call items', async () => {
    const captured: { value: { input?: unknown } | null } = { value: null };
    const session = await makeSession(
      [textEvent('continuing'), completedEvent('resp_5')],
      {
        priorMessages: [
          { role: 'user', content: 'do it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
          },
          { role: 'tool', content: '20C, sunny', toolCallId: 'tc_1' },
        ],
        externalTools: [WEATHER_TOOL],
      },
      (req) => {
        captured.value = req as { input?: unknown };
      },
    );
    await session.sendAndWait('');
    const items = captured.value?.input as Array<Record<string, unknown>>;
    expect(items.find((i) => i.type === 'function_call')).toMatchObject({
      type: 'function_call',
      call_id: 'tc_1',
      name: 'get_weather',
    });
    expect(items.find((i) => i.type === 'function_call_output')).toMatchObject({
      type: 'function_call_output',
      call_id: 'tc_1',
      output: '20C, sunny',
    });
  });

  it('falls back to the legacy single-prompt input when previousResponseId is set (server-side state)', async () => {
    const captured: { value: { input?: unknown } | null } = { value: null };
    const session = await makeSession(
      [textEvent('ack'), completedEvent('resp_6')],
      { previousResponseId: 'resp_prior', priorMessages: [{ role: 'user', content: 'older' }] },
      (req) => {
        captured.value = req as { input?: unknown };
      },
    );
    await session.sendAndWait('new prompt');
    // With server-side state we send only the new prompt — the
    // historical priorMessages are NOT replayed (OpenAI already has them).
    expect(captured.value?.input).toBe('new prompt');
  });

  it('re-sends instructions alongside previous_response_id (the API does not carry them over)', async () => {
    const requests: Array<{ instructions?: string; previous_response_id?: string }> = [];
    const session = await makeSession(
      [textEvent('ack'), completedEvent('resp_7')],
      { previousResponseId: 'resp_prior' },
      (req) => {
        requests.push(req as { instructions?: string; previous_response_id?: string });
      },
    );
    await session.sendAndWait('follow-up');
    expect(requests[0]?.previous_response_id).toBe('resp_prior');
    expect(requests[0]?.instructions).toBe('You are a test assistant.');
  });
});
