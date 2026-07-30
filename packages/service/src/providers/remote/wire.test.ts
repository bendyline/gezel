import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, RemoteInferFrameSchema, RemoteInferRequestSchema } from './wire.js';

describe('remote wire contract', () => {
  it('parses a minimal valid infer request and defaults priorMessages', () => {
    const parsed = RemoteInferRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      model: 'llama-cpp:qwen2.5-72b',
      systemMessage: 'You are helpful.',
      prompt: 'hello',
      queue: {
        lane: 'interactive',
        sessionId: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        actorLabel: 'Mira',
        affinity: true,
      },
    });
    expect(parsed.priorMessages).toEqual([]);
    expect(parsed.queue.lane).toBe('interactive');
    expect(parsed.queue.projectId).toBe('p1');
    expect(parsed.queue.actorLabel).toBe('Mira');
  });

  it('carries tools, layers, tuning, and prior tool-call history', () => {
    const parsed = RemoteInferRequestSchema.parse({
      protocolVersion: 1,
      model: 'm',
      systemMessage: 'sys',
      systemPromptLayers: { gezel: 'g', project: 'gp' },
      volatileContext: 'files…',
      prompt: '',
      priorMessages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'read_file', arguments: '{}' }],
        },
        { role: 'tool', content: 'file body', toolCallId: 't1' },
      ],
      tools: [{ name: 'read_file', parameters: { type: 'object' } }],
      tuning: { sampling: { temperature: 0.7 } },
      queue: { lane: 'background', affinity: false },
    });
    expect(parsed.priorMessages).toHaveLength(3);
    expect(parsed.tools?.[0]?.name).toBe('read_file');
  });

  it('rejects a request missing the queue hints', () => {
    expect(() =>
      RemoteInferRequestSchema.parse({
        protocolVersion: 1,
        model: 'm',
        systemMessage: 's',
        prompt: 'p',
      }),
    ).toThrow();
  });

  it('parses every response frame variant', () => {
    const frames = [
      { type: 'delta', text: 'tok' },
      { type: 'tool_call', calls: [{ id: 'a', name: 'write_file', arguments: '{"path":"x"}' }] },
      {
        type: 'usage',
        model: 'm',
        inputTokens: 10,
        outputTokens: 5,
        contextUtilization: { used: 4000, limit: 10000 },
      },
      { type: 'reasoning', text: 'thinking' },
      { type: 'warning', message: 'ramble aborted' },
      { type: 'queued', aheadOf: 2 },
      { type: 'phase', phase: 'loading_model', progress: 0.5 },
      { type: 'done' },
      { type: 'error', code: 'model_not_loaded', message: 'nope' },
    ];
    for (const f of frames) {
      expect(RemoteInferFrameSchema.parse(f).type).toBe(f.type);
    }
  });

  it('rejects an unknown frame type', () => {
    expect(() => RemoteInferFrameSchema.parse({ type: 'bogus', x: 1 })).toThrow();
  });
});
