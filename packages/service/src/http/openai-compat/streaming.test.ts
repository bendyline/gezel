import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExternalToolCall,
  LLMSession,
  ToolArgsDeltaMeta,
  TurnUsage,
} from '../../providers/types.js';
import { createStreamingDiagnostics, snapshotStreamingDiagnostics } from './streaming-telemetry.js';
import { type SSEWriter, runStreaming } from './streaming.js';
import { ToolCallStreamFilter } from './tool-call-stream-filter.js';

function fakeSession(input: {
  chunks: string[];
  reasoningChunks?: string[];
  toolArgChunks?: Array<{ name: string; chunk: string; meta?: ToolArgsDeltaMeta }>;
  calls?: ExternalToolCall[];
  sendGate?: Promise<void>;
  lifecycle?: { activeReasoningSubscriptions: number; reasoningSubscribeCalls: number };
}): LLMSession {
  const deltaHandlers = new Set<(chunk: string) => void>();
  const reasoningHandlers = new Set<(chunk: string) => void>();
  const toolArgHandlers = new Set<
    (name: string, chunk: string, meta?: ToolArgsDeltaMeta) => void
  >();
  const usageHandlers = new Set<(usage: TurnUsage) => void>();

  return {
    async sendAndWait(): Promise<string> {
      await input.sendGate;
      for (const chunk of input.reasoningChunks ?? []) {
        for (const handler of reasoningHandlers) handler(chunk);
      }
      for (const { name, chunk, meta } of input.toolArgChunks ?? []) {
        for (const handler of toolArgHandlers) handler(name, chunk, meta);
      }
      for (const chunk of input.chunks) {
        for (const handler of deltaHandlers) handler(chunk);
      }
      return input.chunks.join('');
    },
    onDelta(handler: (chunk: string) => void): () => void {
      deltaHandlers.add(handler);
      return () => deltaHandlers.delete(handler);
    },
    onReasoningDelta(handler: (chunk: string) => void): () => void {
      reasoningHandlers.add(handler);
      if (input.lifecycle) {
        input.lifecycle.activeReasoningSubscriptions += 1;
        input.lifecycle.reasoningSubscribeCalls += 1;
      }
      return () => {
        reasoningHandlers.delete(handler);
        if (input.lifecycle) input.lifecycle.activeReasoningSubscriptions -= 1;
      };
    },
    onUsage(handler: (usage: TurnUsage) => void): () => void {
      usageHandlers.add(handler);
      return () => usageHandlers.delete(handler);
    },
    onToolArgsDelta(
      handler: (name: string, chunk: string, meta?: ToolArgsDeltaMeta) => void,
    ): () => void {
      toolArgHandlers.add(handler);
      return () => toolArgHandlers.delete(handler);
    },
    capturedToolCalls(): ExternalToolCall[] {
      return input.calls ?? [];
    },
    providerState() {
      return {};
    },
    async disconnect(): Promise<void> {},
  } as unknown as LLMSession;
}

function collectingSink(): {
  sink: SSEWriter;
  frames: Array<Record<string, unknown>>;
  rawWrites: string[];
} {
  const frames: Array<Record<string, unknown>> = [];
  const rawWrites: string[] = [];
  return {
    frames,
    rawWrites,
    sink: {
      async writeSSE(message): Promise<void> {
        if (message.data !== '[DONE]') {
          frames.push(JSON.parse(message.data) as Record<string, unknown>);
        }
      },
      async write(input): Promise<void> {
        rawWrites.push(typeof input === 'string' ? input : new TextDecoder().decode(input));
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function choice(frame: Record<string, unknown>): {
  delta?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] };
  finish_reason?: string | null;
} | null {
  const choices = frame.choices as
    | Array<{
        delta?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] };
        finish_reason?: string | null;
      }>
    | undefined;
  return choices?.[0] ?? null;
}

describe('ToolCallStreamFilter', () => {
  it('hides a plain Hermes envelope even when both markers split across chunks', () => {
    const filter = new ToolCallStreamFilter();
    let visible = '';
    visible += filter.push('Before.<to');
    visible += filter.push('ol_call><function=bash><parameter=command>pw');
    visible += filter.push('d</parameter></function></tool_');
    visible += filter.push('call>After.');
    visible += filter.flush();

    expect(visible).toBe('Before.After.');
  });

  it('preserves a held ordinary-text suffix when the stream ends', () => {
    const filter = new ToolCallStreamFilter();
    expect(filter.push('2 <')).toBe('2 ');
    expect(filter.flush()).toBe('<');
  });

  it('accepts the canonical special-token wrapper and its non-slash close form', () => {
    const filter = new ToolCallStreamFilter();
    expect(filter.push('a<|tool_call|>{"name":"bash"}<tool_call>b') + filter.flush()).toBe('ab');
  });

  it('reports suppressed tool-call bodies incrementally without exposing them as content', () => {
    const events: string[] = [];
    const filter = new ToolCallStreamFilter({
      onStart: () => events.push('start'),
      onBodyDelta: (chunk) => events.push(`body:${chunk}`),
      onEnd: () => events.push('end'),
    });

    const visible =
      filter.push('Before<tool_call>{"name":"write",') +
      filter.push('"arguments":{"path":"a"}}</tool_call>After') +
      filter.flush();

    expect(visible).toBe('BeforeAfter');
    expect(events[0]).toBe('start');
    expect(events.at(-1)).toBe('end');
    expect(
      events
        .filter((event) => event.startsWith('body:'))
        .join('')
        .replaceAll('body:', ''),
    ).toBe('{"name":"write","arguments":{"path":"a"}}');
  });
});

describe('runStreaming textual tool-call suppression', () => {
  it('sends prose plus one structured call without leaking the raw Pi-visible markup', async () => {
    const session = fakeSession({
      chunks: [
        "Let me check what's available.\n\n<to",
        'ol_call>\n<function=bash>\n<parameter=command>\n',
        'pwd\n</parameter>\n</function>\n</tool_',
        'call>\n\nI will continue after the result.',
      ],
      calls: [{ id: 'call_bash', name: 'bash', arguments: '{"command":"pwd"}' }],
    });
    const { sink, frames } = collectingSink();

    await runStreaming(session, 'build it', 'gezel:test', sink, () => 123, {
      suppressTextualToolCalls: true,
    });

    const content = frames.map((frame) => choice(frame)?.delta?.content ?? '').join('');
    expect(content).toBe("Let me check what's available.\n\n\n\nI will continue after the result.");
    expect(content).not.toContain('<tool_call>');
    expect(content).not.toContain('<function=bash>');

    const structured = frames.find((frame) => choice(frame)?.delta?.tool_calls);
    expect(choice(structured!)?.delta?.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_bash',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"pwd"}' },
      },
    ]);
    expect(choice(frames.at(-1)!)?.finish_reason).toBe('tool_calls');
  });

  it('leaves literal tool-call markup alone when suppression is not requested', async () => {
    const session = fakeSession({ chunks: ['Show <tool_call>example</tool_call> literally.'] });
    const { sink, frames } = collectingSink();

    await runStreaming(session, 'quote it', 'gezel:test', sink, () => 123);

    const content = frames.map((frame) => choice(frame)?.delta?.content ?? '').join('');
    expect(content).toBe('Show <tool_call>example</tool_call> literally.');
  });
});

describe('runStreaming live tool calls', () => {
  it('promotes a suppressed canonical textual call into live tool progress', async () => {
    const finalArguments = '{"path":"game.js","content":"startGame()"}';
    const session = fakeSession({
      chunks: [
        '<tool_call>{"name":"write","arguments":{"path":"game.js",',
        '"content":"startGame()"}}</tool_call>',
      ],
      calls: [{ id: 'repaired-write', name: 'write', arguments: finalArguments }],
    });
    const { sink, frames } = collectingSink();

    await runStreaming(session, 'write it', 'gezel:test', sink, () => 123, {
      suppressTextualToolCalls: true,
      streamToolCallDeltas: true,
      toolCallNames: ['write'],
    });

    const deltas = frames.flatMap((frame) => choice(frame)?.delta?.tool_calls ?? []) as Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[0]).toMatchObject({ function: { name: 'write' } });
    expect(deltas.map((delta) => delta.function?.arguments ?? '').join('')).toBe(finalArguments);
    expect(frames.map((frame) => choice(frame)?.delta?.content ?? '').join('')).toBe('');
  });

  it('announces a Hermes textual call early and reconciles its arguments at completion', async () => {
    const finalArguments = '{"command":"pwd"}';
    const session = fakeSession({
      chunks: [
        '<tool_call><function=bash><parameter=command>pw',
        'd</parameter></function></tool_call>',
      ],
      calls: [{ id: 'repaired-bash', name: 'bash', arguments: finalArguments }],
    });
    const { sink, frames } = collectingSink();

    await runStreaming(session, 'inspect it', 'gezel:test', sink, () => 123, {
      suppressTextualToolCalls: true,
      streamToolCallDeltas: true,
      toolCallNames: ['bash'],
    });

    const deltas = frames.flatMap((frame) => choice(frame)?.delta?.tool_calls ?? []) as Array<{
      function?: { name?: string; arguments?: string };
    }>;
    expect(deltas[0]).toMatchObject({ function: { name: 'bash', arguments: '' } });
    expect(deltas.map((delta) => delta.function?.arguments ?? '').join('')).toBe(finalArguments);
  });

  it('streams argument fragments and does not duplicate them in the final captured call', async () => {
    const finalArguments = '{"path":"app.js","content":"console.log(1)"}';
    const session = fakeSession({
      chunks: [],
      toolArgChunks: [
        { name: 'write_file', chunk: '{"path":"app.js",' },
        { name: 'write_file', chunk: '"content":"console.log(1)"}' },
      ],
      calls: [{ id: 'provider-call-1', name: 'write_file', arguments: finalArguments }],
    });
    const { sink, frames } = collectingSink();

    await runStreaming(session, 'write it', 'gezel:test', sink, () => 123, {
      streamToolCallDeltas: true,
    });

    const deltas = frames
      .flatMap((frame) => choice(frame)?.delta?.tool_calls ?? [])
      .map(
        (call) =>
          call as {
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          },
      );
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      index: 0,
      type: 'function',
      function: { name: 'write_file' },
    });
    expect(deltas[0]?.id).toMatch(/^call_/);
    expect(deltas[1]).toMatchObject({
      index: 0,
      function: { arguments: '"content":"console.log(1)"}' },
    });
    expect(deltas.map((delta) => delta.function?.arguments ?? '').join('')).toBe(finalArguments);
    expect(choice(frames.at(-1)!)?.finish_reason).toBe('tool_calls');
  });

  it('holds argument bytes that precede the first tool name', async () => {
    const session = fakeSession({
      chunks: [],
      toolArgChunks: [
        { name: '', chunk: '{"path":' },
        { name: 'read_file', chunk: '"README.md"}' },
      ],
      calls: [{ id: 'provider-call-2', name: 'read_file', arguments: '{"path":"README.md"}' }],
    });
    const { sink, frames } = collectingSink();

    await runStreaming(session, 'read it', 'gezel:test', sink, () => 123, {
      streamToolCallDeltas: true,
    });

    const toolDelta = frames
      .map((frame) => choice(frame)?.delta?.tool_calls?.[0])
      .find(Boolean) as {
      function: { name: string; arguments: string };
    };
    expect(toolDelta.function).toEqual({
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    });
  });

  it('keeps parallel calls to the same tool separated by provider index and id', async () => {
    const session = fakeSession({
      chunks: [],
      toolArgChunks: [
        { name: 'read_file', chunk: '{"path":"a.md"}', meta: { index: 0, id: 'call_a' } },
        { name: 'read_file', chunk: '{"path":"b.md"}', meta: { index: 1, id: 'call_b' } },
      ],
      calls: [
        { id: 'call_a', name: 'read_file', arguments: '{"path":"a.md"}' },
        { id: 'call_b', name: 'read_file', arguments: '{"path":"b.md"}' },
      ],
    });
    const { sink, frames } = collectingSink();

    await runStreaming(session, 'read both', 'gezel:test', sink, () => 123, {
      streamToolCallDeltas: true,
    });

    const calls = frames
      .flatMap((frame) => choice(frame)?.delta?.tool_calls ?? [])
      .map(
        (call) =>
          call as {
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          },
      );
    expect(calls).toMatchObject([
      {
        index: 0,
        id: 'call_a',
        function: { name: 'read_file', arguments: '{"path":"a.md"}' },
      },
      {
        index: 1,
        id: 'call_b',
        function: { name: 'read_file', arguments: '{"path":"b.md"}' },
      },
    ]);
  });
});

describe('runStreaming reasoning compatibility', () => {
  it('forwards opted-in reasoning on its own delta channel and unsubscribes', async () => {
    const lifecycle = { activeReasoningSubscriptions: 0, reasoningSubscribeCalls: 0 };
    const session = fakeSession({
      reasoningChunks: ['Inspecting ', 'the workspace.'],
      chunks: ['Here is the result.'],
      lifecycle,
    });
    const { sink, frames } = collectingSink();

    const mirroredContent: string[] = [];
    const mirroredReasoning: string[] = [];
    const result = await runStreaming(session, 'inspect it', 'gezel:test', sink, () => 123, {
      includeReasoning: true,
      onContentDelta: (chunk) => mirroredContent.push(chunk),
      onReasoningDelta: (chunk) => mirroredReasoning.push(chunk),
    });

    const reasoning = frames.map((frame) => choice(frame)?.delta?.reasoning_content ?? '').join('');
    const content = frames.map((frame) => choice(frame)?.delta?.content ?? '').join('');
    expect(reasoning).toBe('Inspecting the workspace.');
    expect(content).toBe('Here is the result.');
    expect(result).toMatchObject({
      content: 'Here is the result.',
      reasoning: 'Inspecting the workspace.',
      finishReason: 'stop',
    });
    expect(mirroredContent.join('')).toBe(result.content);
    expect(mirroredReasoning.join('')).toBe(result.reasoning);
    expect(lifecycle.reasoningSubscribeCalls).toBe(1);
    expect(lifecycle.activeReasoningSubscriptions).toBe(0);
  });

  it('does not subscribe to or expose reasoning by default', async () => {
    const lifecycle = { activeReasoningSubscriptions: 0, reasoningSubscribeCalls: 0 };
    const session = fakeSession({
      reasoningChunks: ['private thought'],
      chunks: ['visible reply'],
      lifecycle,
    });
    const { sink, frames } = collectingSink();

    await runStreaming(session, 'answer it', 'gezel:test', sink, () => 123);

    expect(frames.some((frame) => choice(frame)?.delta?.reasoning_content)).toBe(false);
    expect(lifecycle.reasoningSubscribeCalls).toBe(0);
    expect(lifecycle.activeReasoningSubscriptions).toBe(0);
  });
});

describe('runStreaming idle keepalive and diagnostics', () => {
  it('writes ignorable SSE comments during silence and records lifecycle timings', async () => {
    vi.useFakeTimers();
    let releaseSend = (): void => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const diagnostics = createStreamingDiagnostics(Date.now());
    const session = fakeSession({ chunks: ['Finished.'], sendGate });
    const { sink, frames, rawWrites } = collectingSink();

    const running = runStreaming(session, 'wait for it', 'gezel:test', sink, () => 123, {
      keepaliveIntervalMs: 1_000,
      diagnostics,
    });
    await vi.advanceTimersByTimeAsync(3_100);
    releaseSend();
    await running;

    expect(rawWrites.length).toBeGreaterThanOrEqual(3);
    expect(rawWrites.every((write) => write === ': keepalive\n\n')).toBe(true);
    expect(frames.map((frame) => choice(frame)?.delta?.content ?? '').join('')).toBe('Finished.');
    const snapshot = snapshotStreamingDiagnostics(diagnostics);
    expect(snapshot).toMatchObject({
      lastOutbound: 'done',
      lastProviderActivity: 'content',
      contentChunks: 1,
      keepalives: rawWrites.length,
    });
    expect(snapshot.responseId).toMatch(/^chatcmpl-/);
    expect(snapshot.maxOutboundSilenceMs).toBeGreaterThanOrEqual(1_000);
  });
});
