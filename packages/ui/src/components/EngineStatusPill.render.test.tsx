import type { ConfigResponse, QueueStatusResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { providerLabel } from './provider-label.js';
import type { LiveTurnState } from './useOnDeviceLiveTurns.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

// Radix Popper measures tooltip content with ResizeObserver. jsdom does not
// provide it, so give the focused segment-hover test the inert browser shape.
vi.stubGlobal(
  'ResizeObserver',
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

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
      deviceSafety: { mode: 'observe' },
    } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      providers: {
        ds4: queueState(0),
        'llama-cpp': queueState(1),
      },
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
      sessions: [],
      cache: [],
      deviceHealth: {
        state: 'healthy',
        mode: 'observe',
        sampledAt: '2026-07-29T12:00:00.000Z',
        sources: ['test'],
        readings: [{ vendor: 'nvidia', deviceId: '0', temperatureC: 61 }],
        reasons: [],
        summary: 'device telemetry healthy (test)',
      },
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

  it('persists the Observe/Manage choice from the engine pill', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateConfig).mockResolvedValue({
      provider: 'ds4',
      defaultModel: {
        ds4: 'deepseek-v4-flash',
        'llama-cpp': 'talkie-1930-13b-q4',
      },
      deviceSafety: { mode: 'guard' },
    } as ConfigResponse);
    render(<EngineStatusPill />);

    await user.click(
      await screen.findByRole('button', {
        name: /DwarfStar.*DeepSeek V4 Flash/i,
      }),
    );
    const policy = screen.getByRole('group', { name: 'Machine health policy' });
    expect(within(policy).getByRole('button', { name: 'Observe' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(policy).getByRole('button', { name: 'Manage' }));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        deviceSafety: { mode: 'guard' },
      });
      expect(within(policy).getByRole('button', { name: 'Manage' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  it('shows the live inference-memory pool while the dropdown is open', async () => {
    const user = userEvent.setup();
    const GiB = 1024 ** 3;
    vi.mocked(api.getMachineMemoryUsage).mockResolvedValue({
      kind: 'vram',
      totalBytes: 24 * GiB,
      usedBytes: 9 * GiB,
      gezelBytesEstimated: 5 * GiB,
      gezelBytesObserved: null,
      gezelInfraBytes: 0,
      gezelModelWeightsBytes: 4 * GiB,
      gezelModelCacheBytes: 1 * GiB,
      engineReservedBytes: 5 * GiB,
      engineBudgetBytes: 40 * GiB,
      residentModels: [],
      gezelEngineProcessCount: 0,
      orphanedGezelEngineProcessCount: 0,
      otherBytes: 4 * GiB,
      cachedBytes: null,
      freeBytes: 15 * GiB,
      sampledAt: '2026-07-29T12:00:00.000Z',
      source: 'device-health',
      deviceNames: ['Test GPU'],
    });
    render(<EngineStatusPill />);

    await user.click(
      await screen.findByRole('button', {
        name: /DwarfStar.*DeepSeek V4 Flash/i,
      }),
    );

    const strip = await screen.findByRole('img', {
      name: /VRAM: 9\.0 GiB of 24\.0 GiB used, Gezel estimated 5\.0 GiB/i,
    });
    expect(strip).toBeInTheDocument();
    expect(screen.getByText('Gezel ~5.0 GiB')).toBeInTheDocument();
    // Zero-byte pieces of the breakdown stay out of the announcement.
    expect(strip).not.toHaveAccessibleName(/Core Gezel infra/i);
    expect(strip).toHaveAccessibleName(/Model weights about 4\.0 GiB/i);
    expect(strip).toHaveAccessibleName(/Model cache about 1\.0 GiB/i);
    expect(screen.getByText('Other 4.0 GiB')).toBeInTheDocument();
    expect(screen.getByText(/Test GPU/)).toBeInTheDocument();

    const weightsSegment = strip.querySelector('.machine-memory-segment-gezel-weights');
    expect(weightsSegment).toBeInstanceOf(HTMLElement);
    await user.hover(weightsSegment as HTMLElement);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Model weights · ~4.0 GiB (resident model parameters)',
    );
  });

  it('states the reservation and its models instead of filling the bar the driver cannot measure', async () => {
    const user = userEvent.setup();
    const GiB = 1024 ** 3;
    vi.mocked(api.getMachineMemoryUsage).mockResolvedValue({
      kind: 'vram',
      totalBytes: 31.9 * GiB,
      usedBytes: null,
      gezelBytesEstimated: 0,
      gezelBytesObserved: null,
      gezelInfraBytes: 0,
      gezelModelWeightsBytes: 0,
      gezelModelCacheBytes: 0,
      engineReservedBytes: 50 * GiB,
      engineBudgetBytes: 68.4 * GiB,
      residentModels: [
        {
          provider: 'llama-cpp',
          modelId: 'qwen3.6-27b-q4',
          reservedBytes: 19.1 * GiB,
          replicaCount: 1,
        },
        {
          provider: 'llama-cpp',
          modelId: 'talkie-1930-13b-q4',
          reservedBytes: 30.9 * GiB,
          replicaCount: 2,
        },
      ],
      gezelEngineProcessCount: 0,
      orphanedGezelEngineProcessCount: 0,
      otherBytes: null,
      cachedBytes: null,
      freeBytes: null,
      sampledAt: '2026-07-29T12:00:00.000Z',
      source: 'capacity-only',
      deviceNames: ['AMD Radeon AI PRO R9700'],
    });
    render(<EngineStatusPill />);

    await user.click(await screen.findByRole('button', { name: /Talkie 1930 13B/i }));

    const strip = await screen.findByRole('img', { name: /VRAM: 31\.9 GiB total/i });
    // The pool is unmeasured, so nothing is attributed to it — the old
    // behaviour clamped the reservation to the card and drew a full bar.
    expect(strip).not.toHaveAccessibleName(/Gezel estimated/i);
    expect(strip).not.toHaveAccessibleName(/other use/i);
    expect(strip.querySelector('.machine-memory-segment-gezel')).toBeNull();
    expect(strip).toHaveClass('machine-memory-bar-unknown');
    expect(document.querySelector('.machine-memory-swatch-gezel')).toBeNull();

    expect(
      screen.getByText(
        "Models reserve ~50.0 GiB of ~68.4 GiB — this card's memory plus a share of system memory",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('2 models loaded')).toBeInTheDocument();
    // Known ids take their catalog name; the rest fall back to the id.
    expect(screen.getByText('Talkie 1930 13B ×2')).toBeInTheDocument();
    expect(screen.getByText('qwen3.6-27b-q4')).toBeInTheDocument();
  });

  it('separates observed macOS footprint, model reservation, and orphaned engines', async () => {
    const user = userEvent.setup();
    const GiB = 1024 ** 3;
    vi.mocked(api.getMachineMemoryUsage).mockResolvedValue({
      kind: 'unified',
      totalBytes: 128 * GiB,
      usedBytes: 100 * GiB,
      gezelBytesEstimated: 36 * GiB,
      gezelBytesObserved: 76 * GiB,
      gezelInfraBytes: 40 * GiB,
      gezelModelWeightsBytes: 30 * GiB,
      gezelModelCacheBytes: 6 * GiB,
      engineReservedBytes: 36 * GiB,
      engineBudgetBytes: null,
      residentModels: [],
      gezelEngineProcessCount: 2,
      orphanedGezelEngineProcessCount: 2,
      otherBytes: 24 * GiB,
      cachedBytes: 20 * GiB,
      freeBytes: 8 * GiB,
      sampledAt: '2026-07-29T12:00:00.000Z',
      source: 'system-memory',
      deviceNames: [],
    });
    render(<EngineStatusPill />);

    await user.click(
      await screen.findByRole('button', {
        name: /DwarfStar.*DeepSeek V4 Flash/i,
      }),
    );

    const strip = await screen.findByRole('img', {
      name: /Gezel observed footprint 76\.0 GiB/i,
    });
    expect(strip).toHaveAccessibleName(/Core Gezel infra about 40\.0 GiB/i);
    expect(strip).toHaveAccessibleName(/Model weights about 30\.0 GiB/i);
    expect(strip).toHaveAccessibleName(/Model cache about 6\.0 GiB/i);
    expect(strip).toHaveAccessibleName(/Models reserve ~36\.0 GiB for capacity planning/i);
    expect(strip).toHaveAccessibleName(/2 leftover Gezel engine processes/i);
    expect(screen.getByText('Gezel 76.0 GiB')).toBeInTheDocument();
    expect(screen.getByText('Cached 20.0 GiB')).toBeInTheDocument();
    expect(strip).toHaveAccessibleName(/cached files 20\.0 GiB, available to apps/i);
    expect(screen.getByText('Models reserve ~36.0 GiB for capacity planning')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Includes 2 leftover Gezel engine processes from an earlier service session',
      ),
    ).toBeInTheDocument();
  });
});
