import type { ConfigResponse, QueueStatusResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { providerLabel } from './provider-label.js';
import type { LiveTurnState } from './useOnDeviceLiveTurns.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

let mockLiveTurns = new Map<string, LiveTurnState>();
vi.mock('./useOnDeviceLiveTurns.js', () => ({
  useOnDeviceLiveTurns: () => mockLiveTurns,
}));

vi.mock('../shared-chat-events.js', () => ({
  streamSharedAllChatEvents: async function* () {
    // Per-provider phase/stats state is supplied by the hook mock above.
  },
}));

const { EngineStatusPill } = await import('./EngineStatusPill.js');
const { api } = await import('../api.js');

function queueState(running: number) {
  return {
    running,
    queuedInteractive: 0,
    queuedBackground: 0,
    concurrency: 1,
    maxConcurrency: 1,
    active: [],
    pending: [],
  };
}

describe('EngineStatusPill — simultaneous local engines', () => {
  beforeEach(() => {
    mockLiveTurns = new Map([
      [
        'talkie-session',
        {
          provider: 'llama-cpp',
          phase: 'prefill',
          label: 'Processing prompt (50%)',
          progress: 0.5,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
        },
      ],
    ]);
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'ds4',
      defaultModel: {
        ds4: 'deepseek-v4-flash',
        'llama-cpp': 'talkie-1930-13b-q4',
      },
    } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      providers: {
        ds4: queueState(0),
        'llama-cpp': queueState(1),
      },
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
      sessions: [],
      cache: [],
      at: '',
    } as QueueStatusResponse);
    vi.mocked(api.listInflightTurns).mockResolvedValue({
      inflight: [
        {
          sessionId: 'talkie-session',
          gezelId: 'liesel',
          projectId: 'just-chat',
          providerName: 'llama-cpp',
          model: 'talkie-1930-13b-q4',
          userText: 'hi there Liesel',
          startedAt: Date.now(),
          elapsedMs: 17_000,
        },
      ],
    } as never);
    vi.mocked(api.listDs4Models).mockResolvedValue({
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' } as never],
    });
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [{ id: 'talkie-1930-13b-q4', name: 'Talkie 1930 13B' } as never],
    });
  });

  it('keeps the idle DwarfStar pill and adds a busy llama.cpp/Talkie pill', async () => {
    const { container } = render(<EngineStatusPill />);

    await waitFor(() => {
      expect(container.querySelectorAll('.engine-pill')).toHaveLength(2);
    });

    const dwarfStar = await screen.findByRole('button', {
      name: /DwarfStar.*DeepSeek V4 Flash/i,
    });
    const talkie = await screen.findByRole('button', { name: /Talkie 1930 13B/i });

    expect(dwarfStar).not.toHaveClass('engine-pill-busy');
    expect(talkie).toHaveClass('engine-pill-busy');
    expect(talkie).toHaveTextContent(providerLabel('llama-cpp', window.__GEZEL__?.platform));
    expect(talkie.querySelector('.engine-pill-progress')).toBeInTheDocument();
  });
});
