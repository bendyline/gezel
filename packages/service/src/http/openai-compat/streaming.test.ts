import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalToolCall, LLMSession, TurnUsage } from '../../providers/types.js';
import { createStreamingDiagnostics, snapshotStreamingDiagnostics } from './streaming-telemetry.js';
import { type SSEWriter, runStreaming } from './streaming.js';
import { ToolCallStreamFilter } from './tool-call-stream-filter.js';

function fakeSession(input: {
  chunks: string[];
  reasoningChunks?: string[];
  calls?: ExternalToolCall[];
  sendGate?: Promise<void>;
  lifecycle?: { activeReasoningSubscriptions: number; reasoningSubscribeCalls: number };
}): LLMSession {
  const deltaHandlers = new Set<(chunk: string) => void>();
  const reasoningHandlers = new Set<(chunk: string) => void>();
  const usageHandlers = new Set<(usage: TurnUsage) => void>();

  return {
    async sendAndWait(): Promise<string> {
      await input.sendGate;
      for (const chunk of input.reasoningChunks ?? []) {
        for (const handler of reasoningHandlers) handler(chunk);
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
