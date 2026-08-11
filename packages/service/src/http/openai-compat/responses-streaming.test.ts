import { describe, expect, it } from 'vitest';
import type {
  ExternalToolCall,
  LLMSession,
  SendAndWaitOpts,
  TurnUsage,
} from '../../providers/types.js';
import {
  type ResponsesIdKind,
  type ResponsesSSEMessage,
  type ResponsesStreamEvent,
  ResponsesStreamSerializer,
  runResponsesNonStreaming,
  runResponsesStreaming,
  serializeResponsesSseEvent,
} from './responses-streaming.js';

function deterministicIds(): (kind: ResponsesIdKind) => string {
  const counts = new Map<ResponsesIdKind, number>();
  return (kind) => {
    const next = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, next);
    return `${kind}_${next}`;
  };
}

function eventTypes(events: ResponsesStreamEvent[]): string[] {
  return events.map((event) => event.type);
}

function usage(overrides: Partial<TurnUsage> = {}): TurnUsage {
  return {
    model: 'local-model',
    inputTokens: 12,
    outputTokens: 4,
    cachedInputTokens: 3,
    durationMs: 20,
    at: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('ResponsesStreamSerializer', () => {
  it('emits canonical text lifecycle events, immutable snapshots, and final usage', () => {
    const serializer = new ResponsesStreamSerializer({
      model: 'gezel:local-model',
      responseId: 'resp_test',
      createdAt: 1_700_000_000,
      nowSeconds: () => 1_700_000_001,
      idFactory: deterministicIds(),
      echo: { parallelToolCalls: false, maxOutputTokens: 128 },
    });

    const opening = serializer.start();
    const firstDelta = serializer.textDelta('Hello');
    const secondDelta = serializer.textDelta(' world');
    // Private reasoning has no source-event variant and is never subscribed
    // by the high-level adapter; only visible deltas enter this serializer.
    serializer.setUsage(usage());
    const terminal = serializer.complete('Hello world');
    const all = [...opening, ...firstDelta, ...secondDelta, ...terminal];

    expect(eventTypes(all)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(all.map((event) => event.sequence_number)).toEqual(
      Array.from({ length: all.length }, (_, index) => index),
    );

    const created = opening[0];
    expect(created?.type).toBe('response.created');
    if (created?.type === 'response.created') {
      // A later mutation must never rewrite the opening snapshot.
      expect(created.response.output).toEqual([]);
      expect(created.response.status).toBe('in_progress');
    }

    const response = serializer.response();
    expect(response).toMatchObject({
      id: 'resp_test',
      object: 'response',
      model: 'gezel:local-model',
      status: 'completed',
      completed_at: 1_700_000_001,
      output_text: 'Hello world',
      parallel_tool_calls: false,
      max_output_tokens: 128,
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        total_tokens: 16,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
    expect(response.output).toEqual([
      {
        id: 'message_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello world', annotations: [] }],
      },
    ]);

    const completed = terminal.at(-1);
    expect(completed?.type).toBe('response.completed');
    if (completed?.type === 'response.completed') {
      expect(completed.response.usage?.total_tokens).toBe(16);
    }

    const frame = serializeResponsesSseEvent(all[0]!);
    expect(frame.event).toBe('response.created');
    expect(JSON.parse(frame.data)).toMatchObject({ type: 'response.created', sequence_number: 0 });
  });

  it('restores namespaced function tools and unwraps custom-tool input', () => {
    const serializer = new ResponsesStreamSerializer({
      model: 'gezel:local-model',
      responseId: 'resp_tools',
      createdAt: 10,
      nowSeconds: () => 11,
      idFactory: deterministicIds(),
      toolBindings: {
        multi_agent_v1__spawn_agent: {
          kind: 'function',
          name: 'spawn_agent',
          namespace: 'multi_agent_v1',
        },
        local_shell: { kind: 'custom', name: 'shell' },
      },
    });

    const events = [
      ...serializer.start(),
      ...serializer.toolArgumentsDelta('multi_agent_v1__spawn_agent', '{"task":'),
      ...serializer.toolArgumentsDelta('multi_agent_v1__spawn_agent', '"audit"}'),
      ...serializer.toolArgumentsDelta('local_shell', '{"input":"git '),
      ...serializer.toolArgumentsDelta('local_shell', 'status"}'),
      ...serializer.complete('', [
        {
          id: 'provider_function_call',
          name: 'multi_agent_v1__spawn_agent',
          arguments: '{"task":"audit"}',
        },
        {
          id: 'provider_custom_call',
          name: 'local_shell',
          arguments: '{"input":"git status"}',
        },
      ]),
    ];

    expect(eventTypes(events)).toContain('response.function_call_arguments.delta');
    expect(eventTypes(events)).toContain('response.function_call_arguments.done');
    expect(eventTypes(events)).toContain('response.custom_tool_call_input.delta');
    expect(eventTypes(events)).toContain('response.custom_tool_call_input.done');

    const functionDone = events.find(
      (event) => event.type === 'response.output_item.done' && event.item.type === 'function_call',
    );
    expect(functionDone).toMatchObject({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        name: 'spawn_agent',
        namespace: 'multi_agent_v1',
        arguments: '{"task":"audit"}',
        status: 'completed',
      },
    });

    const customInputDone = events.find(
      (event) => event.type === 'response.custom_tool_call_input.done',
    );
    expect(customInputDone).toMatchObject({
      type: 'response.custom_tool_call_input.done',
      input: 'git status',
    });
    const customItem = serializer
      .response()
      .output.find((item) => item.type === 'custom_tool_call');
    expect(customItem).toMatchObject({
      type: 'custom_tool_call',
      call_id: 'provider_custom_call',
      name: 'shell',
      input: 'git status',
      status: 'completed',
    });
  });

  it('emits error and failed envelopes once, preserving bounded partial text', () => {
    const serializer = new ResponsesStreamSerializer({
      model: 'gezel:local-model',
      responseId: 'resp_error',
      createdAt: 10,
      nowSeconds: () => 12,
      idFactory: deterministicIds(),
      limits: { maxOutputTextChars: 4 },
    });

    const events = [...serializer.textDelta('12'), ...serializer.textDelta('345')];
    expect(eventTypes(events)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'error',
      'response.failed',
    ]);
    expect(serializer.response()).toMatchObject({
      status: 'failed',
      error: {
        code: 'server_error',
        message: 'Responses output text exceeded the configured limit',
      },
      output_text: '12',
    });
    expect(serializer.complete('ignored')).toEqual([]);
  });
});

interface FakeSessionControls {
  session: LLMSession;
  getSendOptions(): SendAndWaitOpts | undefined;
  reasoningSubscribed(): boolean;
}

function fakeSession(options: {
  text?: string;
  calls?: ExternalToolCall[];
  failure?: Error;
  waitForAbort?: boolean;
}): FakeSessionControls {
  const deltaHandlers = new Set<(delta: string) => void>();
  const usageHandlers = new Set<(value: TurnUsage) => void>();
  const toolHandlers = new Set<(name: string, delta: string) => void>();
  let sendOptions: SendAndWaitOpts | undefined;
  let subscribedToReasoning = false;

  const session = {
    async sendAndWait(_prompt: string, passed?: SendAndWaitOpts): Promise<string> {
      sendOptions = passed;
      if (options.failure) throw options.failure;
      if (options.waitForAbort) {
        const signal = passed?.queue?.signal;
        if (!signal) throw new Error('missing queue abort signal');
        await new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(new Error('provider turn aborted'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
      for (const handler of deltaHandlers) handler(options.text ?? 'hello');
      for (const handler of usageHandlers) handler(usage());
      return options.text ?? 'hello';
    },
    onDelta(handler: (delta: string) => void): () => void {
      deltaHandlers.add(handler);
      return () => deltaHandlers.delete(handler);
    },
    onReasoningDelta(): () => void {
      subscribedToReasoning = true;
      return () => {};
    },
    onUsage(handler: (value: TurnUsage) => void): () => void {
      usageHandlers.add(handler);
      return () => usageHandlers.delete(handler);
    },
    onToolArgsDelta(handler: (name: string, delta: string) => void): () => void {
      toolHandlers.add(handler);
      return () => toolHandlers.delete(handler);
    },
    capturedToolCalls(): ExternalToolCall[] {
      return options.calls ?? [];
    },
    providerState() {
      return {};
    },
    async disconnect(): Promise<void> {},
  } as unknown as LLMSession;

  return {
    session,
    getSendOptions: () => sendOptions,
    reasoningSubscribed: () => subscribedToReasoning,
  };
}

describe('Responses LLMSession runners', () => {
  it('streams in order, passes continuation options, limits parallel calls, and ends at the terminal event', async () => {
    const abortController = new AbortController();
    const controls = fakeSession({
      text: 'hello',
      calls: [
        { id: 'call_one', name: 'first', arguments: '{}' },
        { id: 'call_two', name: 'second', arguments: '{}' },
      ],
    });
    const writes: ResponsesSSEMessage[] = [];
    const response = await runResponsesStreaming(
      controls.session,
      '',
      'gezel:local-model',
      {
        async writeSSE(message) {
          writes.push(message);
        },
      },
      () => 100,
      {
        responseId: 'resp_runner',
        idFactory: deterministicIds(),
        continueFromToolResult: true,
        signal: abortController.signal,
        attachments: [{ base64: 'AA==', mimeType: 'image/png', filename: 'one.png' }],
        echo: { parallelToolCalls: false },
      },
    );

    expect(controls.getSendOptions()).toMatchObject({
      attachments: [{ base64: 'AA==', mimeType: 'image/png', filename: 'one.png' }],
      continueFromToolResult: true,
      queue: { lane: 'interactive' },
    });
    expect(controls.getSendOptions()?.queue?.signal).toBe(abortController.signal);
    expect(controls.reasoningSubscribed()).toBe(false);
    const wireEvents = writes.map((message) => JSON.parse(message.data) as ResponsesStreamEvent);
    expect(wireEvents[0]?.type).toBe('response.created');
    expect(wireEvents.at(-1)?.type).toBe('response.completed');
    expect(wireEvents.map((event) => event.sequence_number)).toEqual(
      Array.from({ length: wireEvents.length }, (_, index) => index),
    );
    expect(response.output.filter((item) => item.type === 'function_call')).toHaveLength(1);
    expect(response.usage?.total_tokens).toBe(16);
  });

  it('marks a length-capped response incomplete and rethrows non-streaming provider failures', async () => {
    const capped = fakeSession({ text: 'done' });
    const response = await runResponsesNonStreaming(
      capped.session,
      'prompt',
      'gezel:local-model',
      () => 100,
      { lengthCapTokens: 4 },
    );
    expect(response).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      max_output_tokens: 4,
    });

    const failed = fakeSession({ failure: new Error('provider unavailable') });
    await expect(
      runResponsesNonStreaming(failed.session, 'prompt', 'gezel:local-model', () => 100),
    ).rejects.toThrow('provider unavailable');
  });

  it('propagates a caller abort signal into the provider queue turn', async () => {
    const controls = fakeSession({ waitForAbort: true });
    const abortController = new AbortController();
    const pending = runResponsesNonStreaming(
      controls.session,
      'prompt',
      'gezel:local-model',
      () => 100,
      { signal: abortController.signal },
    );

    await Promise.resolve();
    abortController.abort();
    await expect(pending).rejects.toThrow('provider turn aborted');
    expect(controls.getSendOptions()?.queue?.signal).toBe(abortController.signal);
  });

  it('keeps raw streaming provider errors server-side', async () => {
    const controls = fakeSession({
      failure: new Error('secret upstream detail at /Users/example/private'),
    });
    const writes: ResponsesSSEMessage[] = [];
    let observed: unknown;
    const response = await runResponsesStreaming(
      controls.session,
      'prompt',
      'gezel:local-model',
      {
        async writeSSE(message) {
          writes.push(message);
        },
      },
      () => 100,
      {
        onProviderError: (error) => {
          observed = error;
        },
      },
    );

    expect(observed).toBeInstanceOf(Error);
    expect(response).toMatchObject({
      status: 'failed',
      error: {
        code: 'provider_error',
        message: 'The model provider failed while generating this response.',
      },
    });
    expect(writes.map((message) => message.data).join('\n')).not.toContain(
      '/Users/example/private',
    );
    expect(JSON.parse(writes.at(-1)!.data)).toMatchObject({ type: 'response.failed' });
  });
});
