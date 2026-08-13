import type { ChatEventEnvelope } from '@bendyline/gezel';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamState = vi.hoisted(() => ({ events: [] as ChatEventEnvelope[] }));

vi.mock('../api.js', () => ({
  api: {
    allEventsUrl: () => 'http://127.0.0.1/events/chat/all',
    authHeader: () => ({ Authorization: 'Bearer test' }),
    getFetch: () => globalThis.fetch,
  },
}));

vi.mock('../shared-chat-events.js', () => ({
  streamSharedAllChatEvents: async function* () {
    yield* streamState.events;
  },
}));

const { useOnDeviceLiveTurns } = await import('./useOnDeviceLiveTurns.js');

describe('useOnDeviceLiveTurns', () => {
  beforeEach(() => {
    streamState.events = [];
  });

  it('coalesces every generated-output channel into the live character count', async () => {
    const envelope = {
      sessionId: 'session-1',
      gezelId: 'writer-1',
      projectId: 'project-1',
    } as const;
    streamState.events = [
      {
        ...envelope,
        event: { type: 'engine_phase', provider: 'llama-cpp', phase: 'generating' },
      },
      { ...envelope, event: { type: 'delta', content: 'a'.repeat(100) } },
      { ...envelope, event: { type: 'reasoning_delta', content: 'b'.repeat(120) } },
      {
        ...envelope,
        event: { type: 'tool_args_delta', name: 'write_file', content: 'c'.repeat(180) },
      },
    ];

    const { result } = renderHook(() => useOnDeviceLiveTurns(true, true));

    await waitFor(
      () => {
        expect(result.current.get('session-1')).toMatchObject({
          phase: 'generating',
          gezelId: 'writer-1',
          outputChars: 400,
        });
      },
      { timeout: 2_000 },
    );
  });
});
