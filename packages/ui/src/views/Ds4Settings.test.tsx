import type { ConfigResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/Ds4ModelManager.js', () => ({
  Ds4ModelManager: () => <div data-testid="ds4-model-manager">models</div>,
}));

const { detectDs4Availability } = vi.hoisted(() => ({
  detectDs4Availability: vi.fn(() => ({ status: 'available', backend: 'metal' })),
}));

vi.mock('./ds4-availability.js', () => ({ detectDs4Availability }));

vi.mock('../api.js', () => ({
  api: {
    getDs4Log: vi.fn().mockResolvedValue({
      path: '/tmp/ds4-server-2026-07-18.log',
      tail: '[ds4-server] --ssd-streaming enabled',
    }),
    getMemoryProfile: vi.fn().mockResolvedValue({
      platform: 'darwin',
      totalRamBytes: 128 * 1024 ** 3,
      gpuVramBytes: null,
      source: 'darwin-unified',
      usableBytes: 112 * 1024 ** 3,
    }),
  },
}));

const { Ds4Settings } = await import('./Ds4Settings.js');

describe('Ds4Settings', () => {
  it('describes the safe streaming behavior without exposing residency controls', () => {
    render(
      <Ds4Settings config={{ provider: 'ds4' } as ConfigResponse} onConfigChanged={vi.fn()} />,
    );

    expect(
      screen.getByRole('heading', { name: 'On-device (DwarfStar - DS4)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'DwarfStar models' })).toBeInTheDocument();
    expect(screen.getByText(/engine available · metal/i)).toBeInTheDocument();
    expect(screen.getByText(/SSD streaming stays on automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/Lower quantizations \(Q2\) start faster/i)).toBeInTheDocument();
    // The panel names every family the engine runs, not just the first one it
    // shipped with — ds4 also runs GLM 5.2.
    expect(screen.getByText(/DeepSeek V4 and GLM 5\.2/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Advanced/)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/under ~96 GB/i)).not.toBeInTheDocument();
  });

  it('loads the retained DwarfStar engine log from Diagnostics', async () => {
    const { api } = await import('../api.js');
    render(
      <Ds4Settings config={{ provider: 'ds4' } as ConfigResponse} onConfigChanged={vi.fn()} />,
    );

    await userEvent.setup().click(screen.getByText(/^Diagnostics/));
    await userEvent.setup().click(screen.getByRole('button', { name: /Refresh engine log/i }));

    await waitFor(() => expect(api.getDs4Log).toHaveBeenCalledWith(4096));
    expect(await screen.findByText(/--ssd-streaming enabled/)).toBeInTheDocument();
  });

  // The RAM floor lives in the detector; the panel's job is to hand it this
  // machine's size once the probe answers, so an under-spec box gets the
  // unavailable banner instead of a download list it can't use.
  it('feeds the measured system RAM into the availability check', async () => {
    render(
      <Ds4Settings config={{ provider: 'ds4' } as ConfigResponse} onConfigChanged={vi.fn()} />,
    );

    await waitFor(() =>
      expect(detectDs4Availability).toHaveBeenCalledWith(
        expect.objectContaining({ totalRamBytes: 128 * 1024 ** 3 }),
      ),
    );
  });
});
