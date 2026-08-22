import type { ConfigResponse, QueueStatusResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { type HeaderDensity, HeaderDensityContext } from './header-density.js';
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
vi.mock('./useOnDeviceLiveTurns.js', async (importOriginal) => ({
  // Only the hook is stubbed; `phaseBaseLabel` is a pure helper the pill
  // shares with the hook so both name a detail-less phase the same way.
  ...(await importOriginal<typeof import('./useOnDeviceLiveTurns.js')>()),
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
    vi.mocked(api.getUsage).mockResolvedValue({ providers: {}, lastUpdated: null });
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

  it('restores the last completed turn from daemon usage after a page load', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getUsage).mockResolvedValue({
      providers: {
        'llama-cpp': {
          quotaBuckets: [],
          todayTurns: 1,
          todayTokensIn: 1_234,
          todayTokensOut: 56,
          todayCost: 0,
          totalTurns: 1,
          totalTokensIn: 1_234,
          totalTokensOut: 56,
          totalCost: 0,
          modelSpeeds: [],
          lastTurn: {
            model: 'talkie-1930-13b-q4',
            inputTokens: 1_234,
            outputTokens: 56,
            cost: 0,
            durationMs: 2_000,
            outputTokensPerSec: 28,
            at: '2026-08-18T12:00:00.000Z',
          },
          lastUpdated: '2026-08-18T12:00:00.000Z',
        },
      },
      lastUpdated: '2026-08-18T12:00:00.000Z',
    });

    render(<EngineStatusPill />);
    await user.click(await screen.findByRole('button', { name: /Talkie 1930 13B/i }));

    expect(await screen.findByText('Last turn')).toBeInTheDocument();
    expect(screen.getByText(/1,234 in/)).toHaveTextContent('1,234 in · 56 out · 28 tok/s');
  });

  it('distinguishes chat caches from shared prefixes in engine telemetry', async () => {
    const user = userEvent.setup();
    const GiB = 1024 ** 3;
    const cacheEntry = (sessionId: string) => ({
      sessionId,
      tokenCount: 1_000,
      bytes: GiB,
      lastUsedAt: Date.now(),
      evictionPriority: 'normal' as const,
    });
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      providers: {
        ds4: queueState(0),
        'llama-cpp': queueState(1),
      },
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
      sessions: [],
      cache: [
        {
          providerName: 'llama-cpp',
          totalBytes: 14 * GiB,
          budgetBytes: 16 * GiB,
          warmSessionCount: 4,
          hits: 4,
          misses: 1,
          recentHitRate: 0.8,
          sessions: [
            cacheEntry('chat-a'),
            cacheEntry('prefix-model-a'),
            cacheEntry('chat-b'),
            cacheEntry('prefix-gezel-project-a'),
          ],
        },
      ],
      at: '',
    } as QueueStatusResponse);

    render(<EngineStatusPill />);
    await user.click(await screen.findByRole('button', { name: /Talkie 1930 13B/i }));

    expect(await screen.findByText(/2 chat caches \+ 2 shared prefixes/)).toBeInTheDocument();
    expect(screen.queryByText(/4 threads/)).not.toBeInTheDocument();
  });

  it('shows elapsed work as a minute-and-second clock', async () => {
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    mockLiveTurns = new Map([
      [
        'talkie-session',
        {
          provider: 'llama-cpp',
          phase: 'prefill',
          label: 'Processing prompt (50%)',
          progress: 0.5,
          startedAt: now - 64_000,
          lastEventAt: now,
        },
      ],
    ]);

    try {
      render(<EngineStatusPill />);

      const talkie = await screen.findByRole('button', { name: /Talkie 1930 13B/i });
      expect(talkie.querySelector('.engine-pill-elapsed')).toHaveTextContent('· 1:04');
      expect(talkie.getAttribute('title')).toContain('· 1:04');
      expect(talkie).not.toHaveTextContent('64s');
    } finally {
      dateNow.mockRestore();
    }
  });

  it('keeps the live output estimate out of the pill, in the tooltip and popover', async () => {
    mockLiveTurns = new Map([
      [
        'talkie-session',
        {
          provider: 'llama-cpp',
          phase: 'generating',
          // Older engines may put performance only in the phase detail.
          // The header strips it while the dropdown's Status row keeps it.
          label: 'Generating · 24 tok/s',
          gezelId: 'liesel',
          outputChars: 400,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
        },
      ],
    ]);
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'talkie-1930-13b-q4' },
      roleBasedNameOnlyMode: true,
      deviceSafety: { mode: 'observe' },
    } as ConfigResponse);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        {
          id: 'liesel',
          name: 'Liesel',
          roleBasedName: 'technical-writer',
          updatedAt: '2026-08-13T00:00:00.000Z',
        },
      ],
    });

    const user = userEvent.setup();
    render(<EngineStatusPill />);

    const pill = await screen.findByRole('button', { name: /technical-writer.*Generating/i });
    expect(pill).toHaveTextContent('technical-writer · Generating');
    expect(pill).not.toHaveTextContent('tok');
    expect(pill).not.toHaveTextContent('Liesel');
    expect(pill.getAttribute('title')).toContain('about 100 output tokens');

    await user.click(pill);
    expect(await screen.findByText('This turn')).toBeInTheDocument();
    expect(screen.getByText('≈100 tok')).toBeInTheDocument();
    expect(screen.getByText(/technical-writer · Generating · 24 tok\/s/)).toBeInTheDocument();
  });

  /**
   * MLX's generating detail is telemetry end to end — "24 tok/s · 61
   * tokens". Stripping only the rate used to leave the header reading
   * "Liesel · · 61 tokens": a dangling separator plus the token counter
   * the header is supposed to keep out.
   */
  it('names the phase when the engine detail is telemetry end to end', async () => {
    mockLiveTurns = new Map([
      [
        'talkie-session',
        {
          provider: 'mlx',
          phase: 'generating',
          label: '24 tok/s · 61 tokens',
          gezelId: 'liesel',
          outputTokens: 61,
          tokensPerSec: 24,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
        },
      ],
    ]);
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mlx',
      defaultModel: { mlx: 'talkie-1930-13b-q4' },
      deviceSafety: { mode: 'observe' },
    } as ConfigResponse);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'liesel', name: 'Liesel', updatedAt: '2026-08-13T00:00:00.000Z' }],
    });

    render(<EngineStatusPill />);

    const pill = await screen.findByRole('button', { name: /Generating/i });
    expect(pill).toHaveTextContent('Generating');
    expect(pill).not.toHaveTextContent('tokens');
    expect(pill).not.toHaveTextContent('tok/s');
    expect(pill).not.toHaveTextContent('· ·');
  });

  /**
   * llama-server (`timings_per_token`) and MLX both publish a running
   * `predicted_n` / `output_tokens` counter. When the engine tells us the
   * number there is nothing to approximate, and hedging a figure we were
   * handed reads as a bug.
   */
  it('keeps exact performance counters in the detail dropdown, not the pill', async () => {
    mockLiveTurns = new Map([
      [
        'talkie-session',
        {
          provider: 'llama-cpp',
          phase: 'generating',
          label: 'Generating',
          gezelId: 'liesel',
          // Deliberately inconsistent with the exact counter: whatever the
          // character estimate would say, the engine's number wins.
          outputChars: 400,
          outputTokens: 59,
          tokensPerSec: 24.4,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
        },
      ],
    ]);
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'talkie-1930-13b-q4' },
      deviceSafety: { mode: 'observe' },
    } as ConfigResponse);

    const user = userEvent.setup();
    render(<EngineStatusPill />);

    await waitFor(() => expect(document.querySelectorAll('button').length).toBeGreaterThan(0));
    const pill = [...document.querySelectorAll('button')].find((el) =>
      (el.getAttribute('title') ?? '').includes('Generating'),
    )!;
    expect(pill).not.toHaveTextContent('tok/s');
    expect(pill.getAttribute('title')).not.toContain('tok/s');
    expect(pill.getAttribute('title')).toContain('59 output tokens');
    expect(pill.getAttribute('title')).not.toContain('about');

    await user.click(pill);
    expect(await screen.findByText('This turn')).toBeInTheDocument();
    expect(screen.getByText(/^59 tok · 24 tok\/s$/)).toBeInTheDocument();
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
    const { container } = render(<EngineStatusPill />);

    await user.click(
      await screen.findByRole('button', {
        name: /DwarfStar.*DeepSeek V4 Flash/i,
      }),
    );
    expect(container.querySelector('.engine-pill-popover')).toHaveStyle({ position: 'fixed' });
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

  it('persists the engine-owner idle retention preset', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getEngineRetention).mockResolvedValue({ idleTimeoutMs: 300_000 });
    vi.mocked(api.updateEngineRetention).mockResolvedValue({ idleTimeoutMs: 60_000 });
    render(<EngineStatusPill />);

    await user.click(
      await screen.findByRole('button', {
        name: /DwarfStar.*DeepSeek V4 Flash/i,
      }),
    );
    const retention = screen.getByRole('group', { name: 'Idle model retention' });
    expect(within(retention).getByRole('radio', { name: 'Balanced' })).toBeChecked();

    await user.click(within(retention).getByRole('radio', { name: 'Fast' }));
    await waitFor(() => {
      expect(api.updateEngineRetention).toHaveBeenCalledWith(60_000);
      expect(within(retention).getByRole('radio', { name: 'Fast' })).toBeChecked();
    });
  });

  it('confirms a Hard Stop, cancels all chats, and broadcasts Reactive mode', async () => {
    const user = userEvent.setup();
    vi.mocked(api.emergencyStopChats).mockResolvedValue({
      ok: true,
      engagementMode: 'reactive',
      persisted: true,
      cancelledTurns: 2,
      clearedQueuedMessages: 1,
      clearedDeferredActions: 0,
    });
    const configUpdated = vi.fn();
    window.addEventListener('gezel:config-updated', configUpdated);

    try {
      render(<EngineStatusPill />);
      await user.click(
        await screen.findByRole('button', {
          name: /DwarfStar.*DeepSeek V4 Flash/i,
        }),
      );
      await user.click(screen.getByRole('button', { name: 'Hard Stop' }));

      const dialog = screen.getByRole('alertdialog');
      expect(within(dialog).getByText('Hard stop all chats?')).toBeInTheDocument();
      expect(within(dialog).getByText(/switch to Reactive/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/local engines.*unloaded/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Hard stop' }));

      await waitFor(() => {
        expect(api.emergencyStopChats).toHaveBeenCalledTimes(1);
        expect(configUpdated).toHaveBeenCalledWith(
          expect.objectContaining({ detail: { aiEngagementMode: 'reactive' } }),
        );
      });
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    } finally {
      window.removeEventListener('gezel:config-updated', configUpdated);
    }
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
      name: /Current VRAM use: 9\.0 GB of 24\.0 GB used, Gezel estimated 5\.0 GB/i,
    });
    expect(screen.getByText('Current VRAM use')).toBeInTheDocument();
    expect(strip).toBeInTheDocument();
    expect(screen.getByText('Gezel ~5.0 GB')).toBeInTheDocument();
    // Zero-byte pieces of the breakdown stay out of the announcement.
    expect(strip).not.toHaveAccessibleName(/Core Gezel infra/i);
    expect(strip).toHaveAccessibleName(/Model weights about 4\.0 GB/i);
    expect(strip).toHaveAccessibleName(/Model cache about 1\.0 GB/i);
    const unattributed = screen.getByText('Unattributed 4.0 GB');
    expect(unattributed).toBeInTheDocument();
    expect(unattributed).toHaveAttribute(
      'title',
      'Per-process VRAM use is unavailable; this may include retained Gezel models',
    );
    expect(strip).toHaveAccessibleName(
      /unattributed use 4\.0 GB; this may include retained Gezel models/i,
    );
    expect(screen.getByText(/Test GPU/)).toBeInTheDocument();

    const weightsSegment = strip.querySelector('.machine-memory-segment-gezel-weights');
    expect(weightsSegment).toBeInstanceOf(HTMLElement);
    await user.hover(weightsSegment as HTMLElement);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Model weights · ~4.0 GB (resident model parameters)',
    );
  });

  it('names Windows VRAM owners and can unload an idle model from its countdown', async () => {
    const user = userEvent.setup();
    const GiB = 1024 ** 3;
    const memoryUsage: Awaited<ReturnType<typeof api.getMachineMemoryUsage>> = {
      kind: 'vram',
      totalBytes: 32 * GiB,
      usedBytes: 31 * GiB,
      gezelBytesEstimated: 0,
      gezelBytesObserved: 26 * GiB,
      gezelInfraBytes: 0,
      gezelModelWeightsBytes: 0,
      gezelModelCacheBytes: 26 * GiB,
      engineReservedBytes: 21 * GiB,
      engineBudgetBytes: 64 * GiB,
      residentModels: [],
      engineLifecycles: [
        {
          provider: 'llama-cpp',
          modelId: 'talkie-1930-13b-q4',
          replicaIdx: 0,
          running: true,
          active: false,
          pid: 202,
          lastUsedAt: Date.now(),
          unloadAt: Date.now() + 5 * 60_000,
          idleTimeoutMs: 5 * 60_000,
          releaseReason: 'idle',
        },
      ],
      gpuProcesses: [
        {
          pid: 101,
          name: 'gezel-llama-server.exe',
          dedicatedBytes: 13 * GiB,
          owner: 'machine-engine',
        },
        {
          pid: 202,
          name: 'gezel-llama-server.exe',
          dedicatedBytes: 13 * GiB,
          owner: 'development-engine',
        },
      ],
      gezelEngineProcessCount: 2,
      orphanedGezelEngineProcessCount: 0,
      otherBytes: 5 * GiB,
      cachedBytes: null,
      freeBytes: 1 * GiB,
      sampledAt: '2026-08-10T12:00:00.000Z',
      source: 'device-health',
      deviceNames: ['Radeon'],
    };
    vi.mocked(api.getMachineMemoryUsage)
      .mockResolvedValueOnce(memoryUsage)
      .mockResolvedValue({ ...memoryUsage, engineLifecycles: [] });
    vi.mocked(api.unloadIdleEngine).mockResolvedValue({ ok: true });
    render(<EngineStatusPill />);

    await user.click(await screen.findByRole('button', { name: /Talkie 1930 13B/i }));

    expect(
      await screen.findByText(/Gezel machine engine · gezel-llama-server\.exe/i),
    ).toBeVisible();
    expect(screen.getByText(/Gezel development engine · gezel-llama-server\.exe/i)).toBeVisible();
    expect(screen.getByText('Other 5.0 GB')).toBeVisible();
    expect(screen.getByText(/Unloads in 5:00|Unloads in 4:59/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Unload Talkie 1930 13B now' }));
    expect(api.unloadIdleEngine).toHaveBeenCalledWith({
      provider: 'llama-cpp',
      modelId: 'talkie-1930-13b-q4',
      replicaIdx: 0,
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Unload Talkie 1930 13B now' }),
      ).not.toBeInTheDocument();
    });
  });

  it('states the reservation and its models instead of filling the bar the driver cannot measure', async () => {
    const user = userEvent.setup();
    const GiB = 1024 ** 3;
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [
        {
          id: 'talkie-1930-13b-q4',
          name: 'Talkie 1930 13B',
          plannedSlots: 2,
        } as never,
      ],
    });
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
      enginePools: {
        kind: 'discrete-gpu',
        vramBytes: 30.4 * GiB,
        ramShareBytes: 38 * GiB,
        fastBytes: 30.4 * GiB,
      },
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

    // The pool is unmeasured, so its unactionable meter is omitted — the old
    // behaviour clamped the reservation to the card and drew a full bar.
    expect(screen.getByText('VRAM')).toBeInTheDocument();
    expect(screen.getByText('31.9 GB total')).toBeInTheDocument();
    expect(document.querySelector('.machine-memory-bar')).toBeNull();
    expect(document.querySelector('.machine-memory-swatch-gezel')).toBeNull();

    const capacityMeter = screen.getByRole('img', {
      name: /Model capacity: about 50\.0 GB of 68\.4 GB reserved/i,
    });
    expect(capacityMeter).toHaveAccessibleName(/30\.4 GB VRAM \+ ~38\.0 GB system RAM/i);
    expect(capacityMeter.querySelectorAll('.machine-memory-reservation-segment')).toHaveLength(2);
    expect(screen.getByText('Reserved model capacity')).toBeInTheDocument();
    expect(screen.getByText('Capacity: ~30.4 GB VRAM + ~38.0 GB system RAM')).toBeInTheDocument();
    expect(screen.queryByText(/Capacity planning only/)).not.toBeInTheDocument();
    // Capacity holders are visible as well as accessible. Known ids take
    // their catalog name; the rest fall back to the id.
    expect(screen.getByText('Talkie 1930 13B ×2 · 4 slots')).toBeInTheDocument();
    expect(screen.getByText('~30.9 GB')).toBeInTheDocument();
    expect(screen.getByText('qwen3.6-27b-q4')).toBeInTheDocument();
    expect(screen.getByText('~19.1 GB')).toBeInTheDocument();
    expect(capacityMeter).toHaveAccessibleName(/Talkie 1930 13B ×2 · 4 slots/i);
    expect(capacityMeter).toHaveAccessibleName(/qwen3\.6-27b-q4/i);
  });

  it('scales unified-memory reservations against total RAM and shows the system reserve', async () => {
    const user = userEvent.setup();
    const GiB = 1024 ** 3;
    vi.mocked(api.getMachineMemoryUsage).mockResolvedValue({
      kind: 'unified',
      totalBytes: 128 * GiB,
      usedBytes: 125 * GiB,
      gezelBytesEstimated: 98 * GiB,
      gezelBytesObserved: 103.5 * GiB,
      gezelInfraBytes: 0,
      gezelModelWeightsBytes: 0,
      gezelModelCacheBytes: 98 * GiB,
      engineReservedBytes: 98 * GiB,
      engineBudgetBytes: 112 * GiB,
      enginePools: {
        kind: 'unified',
        vramBytes: 0,
        ramShareBytes: 112 * GiB,
        fastBytes: 112 * GiB,
      },
      residentModels: [
        {
          provider: 'llama-cpp',
          modelId: 'qwen3.6-27b-q8',
          reservedBytes: 98 * GiB,
          replicaCount: 1,
        },
      ],
      gezelEngineProcessCount: 1,
      orphanedGezelEngineProcessCount: 0,
      otherBytes: 21.5 * GiB,
      cachedBytes: 0,
      freeBytes: 3 * GiB,
      sampledAt: '2026-08-10T12:00:00.000Z',
      source: 'system-memory',
      deviceNames: [],
    });
    render(<EngineStatusPill />);

    await user.click(await screen.findByRole('button', { name: /Talkie 1930 13B/i }));

    const capacityMeter = screen.getByRole('img', {
      name: /Model capacity: about 98\.0 GB of 112\.0 GB reserved/i,
    });
    expect(capacityMeter).toHaveAccessibleName(/System reserve about 16\.0 GB/i);
    expect(screen.queryByText(/^Scale:/)).not.toBeInTheDocument();
    expect(capacityMeter.querySelector('.machine-memory-reservation-pool-ram')).toHaveStyle({
      width: '87.5%',
    });
    expect(capacityMeter.querySelector('.machine-memory-reservation-segment')).toHaveStyle({
      width: '76.5625%',
    });
    expect(capacityMeter.querySelector('.machine-memory-reservation-system-reserve')).toHaveStyle({
      width: '12.5%',
    });
  });

  it('shows the on-card ceiling when discrete-GPU spillover is off', async () => {
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
      engineReservedBytes: 29.3 * GiB,
      engineBudgetBytes: 68.4 * GiB,
      enginePools: {
        kind: 'discrete-gpu',
        vramBytes: 30.4 * GiB,
        ramShareBytes: 38 * GiB,
        fastBytes: 30.4 * GiB,
      },
      engineRamSpillover: {
        allowed: false,
        auto: false,
        overridden: false,
        coResidencyBytes: 30.4 * GiB,
      },
      residentModels: [
        {
          provider: 'llama-cpp',
          modelId: 'qwen3.6-27b-q4',
          reservedBytes: 19.1 * GiB,
          replicaCount: 1,
        },
        {
          provider: 'llama-cpp',
          modelId: 'gemma4-4b-q4',
          reservedBytes: 10.2 * GiB,
          replicaCount: 1,
        },
      ],
      gezelEngineProcessCount: 2,
      orphanedGezelEngineProcessCount: 0,
      otherBytes: null,
      cachedBytes: null,
      freeBytes: null,
      sampledAt: '2026-08-10T12:00:00.000Z',
      source: 'capacity-only',
      deviceNames: ['AMD Radeon AI PRO R9700'],
    });
    render(<EngineStatusPill />);

    await user.click(await screen.findByRole('button', { name: /Talkie 1930 13B/i }));

    const capacityMeter = screen.getByRole('img', {
      name: /On-card model capacity: about 29\.3 GB of 30\.4 GB reserved/i,
    });
    expect(capacityMeter).toBeVisible();
    expect(screen.getByText('On-card model capacity')).toBeVisible();
    expect(
      screen.getByText(
        /Concurrent models stay within ~30\.4 GB of graphics memory; system memory is allowed only for a single model too large for the card/i,
      ),
    ).toBeVisible();
    expect(screen.queryByText(/of ~68\.4 GB reserved/i)).not.toBeInTheDocument();
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
      name: /Gezel observed footprint 76\.0 GB/i,
    });
    expect(strip).toHaveAccessibleName(/Gezel about 76\.0 GB/i);
    expect(strip).not.toHaveAccessibleName(/Core Gezel infra/i);
    expect(strip).not.toHaveAccessibleName(/Model weights/i);
    expect(strip).not.toHaveAccessibleName(/Model cache/i);
    expect(strip).toHaveAccessibleName(
      /Models reserve ~36\.0 GB for capacity planning; this can include models that are not running/i,
    );
    expect(strip).toHaveAccessibleName(/2 leftover Gezel engine processes/i);
    expect(screen.getByText('Gezel 76.0 GB')).toBeInTheDocument();
    expect(screen.getByText('Model & file cache 20.0 GB')).toBeInTheDocument();
    expect(strip).toHaveAccessibleName(
      /model and file cache 20\.0 GB, reclaimable by the operating system/i,
    );
    expect(
      screen.getByText(
        'Models reserve ~36.0 GB for capacity planning; this can include models that are not running',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Includes 2 leftover Gezel engine processes from an earlier service session',
      ),
    ).toBeInTheDocument();
  });
});

describe('EngineStatusPill — crowded titlebar', () => {
  const device = providerLabel('llama-cpp', window.__GEZEL__?.platform);

  beforeEach(() => {
    mockLiveTurns = new Map([
      [
        'talkie-session',
        {
          provider: 'llama-cpp',
          phase: 'generating',
          label: 'Generating',
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
      providers: { ds4: queueState(0), 'llama-cpp': queueState(1) },
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
          elapsedMs: 3_000,
        },
      ],
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'liesel', name: 'Liesel', updatedAt: '2026-08-13T00:00:00.000Z' }],
    });
    vi.mocked(api.listDs4Models).mockResolvedValue({
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' } as never],
    });
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [{ id: 'talkie-1930-13b-q4', name: 'Talkie 1930 13B' } as never],
    });
    vi.mocked(api.getUsage).mockResolvedValue({ providers: {}, lastUpdated: null });
  });

  async function pillsAt(density: HeaderDensity) {
    const { container } = render(
      <HeaderDensityContext.Provider value={density}>
        <EngineStatusPill />
      </HeaderDensityContext.Provider>,
    );
    await waitFor(() => {
      const pills = container.querySelectorAll('.engine-pill');
      expect(pills).toHaveLength(2);
      expect(pills[0]).toHaveTextContent('DeepSeek V4 Flash');
      expect(pills[1]).toHaveTextContent('Talkie 1930 13B');
    });
    const [dwarfStar, talkie] = Array.from(container.querySelectorAll<HTMLElement>('.engine-pill'));
    return { dwarfStar: dwarfStar as HTMLElement, talkie: talkie as HTMLElement };
  }

  it('keeps the machine name and the gezel at full density', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { dwarfStar, talkie } = await pillsAt('full');
      expect(dwarfStar).toHaveTextContent('DwarfStar · DeepSeek V4 Flash');
      expect(talkie).toHaveTextContent(device);
      expect(talkie).toHaveTextContent('Liesel');
      expect(
        consoleError.mock.calls.some(([message]) =>
          String(message).includes('change in the order of Hooks'),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('drops the machine name — but not a named engine — when compact', async () => {
    const { dwarfStar, talkie } = await pillsAt('compact');
    // Every local engine wears the machine name, so it distinguishes nothing
    // once a second pill is up; "DwarfStar" still does.
    expect(talkie).not.toHaveTextContent(device);
    expect(dwarfStar).toHaveTextContent('DwarfStar');
    // The model name carried the separator when the machine name preceded it.
    expect(dwarfStar.textContent).not.toMatch(/^\s*·/);
    expect(talkie).toHaveTextContent('Liesel');
    // Nothing is actually lost — the tooltip still names the machine.
    expect(talkie.getAttribute('title')).toContain(device);
  });

  it('drops the gezel name too when tight', async () => {
    const { talkie } = await pillsAt('tight');
    expect(talkie).not.toHaveTextContent('Liesel');
    expect(talkie).toHaveTextContent('Generating');
    expect(talkie).toHaveTextContent('Talkie 1930');
    expect(talkie.getAttribute('title')).toContain('Liesel');
  });
});
