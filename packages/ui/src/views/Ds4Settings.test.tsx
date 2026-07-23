import type { ConfigResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/Ds4ModelManager.js', () => ({
  Ds4ModelManager: () => <div data-testid="ds4-model-manager">models</div>,
}));

vi.mock('./ds4-availability.js', () => ({
  detectDs4Availability: () => ({ status: 'available', backend: 'metal' }),
}));

vi.mock('../api.js', () => ({
  api: {
    getDs4Log: vi.fn().mockResolvedValue({
      path: '/tmp/ds4-server-2026-07-18.log',
      tail: '[ds4-server] --ssd-streaming enabled',
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
    expect(screen.getByRole('heading', { name: 'DeepSeek V4 models' })).toBeInTheDocument();
    expect(screen.getByText(/engine available · metal/i)).toBeInTheDocument();
    expect(screen.getByText(/SSD streaming stays on automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/Q2 is the lighter, faster-starting choice/i)).toBeInTheDocument();
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
});
