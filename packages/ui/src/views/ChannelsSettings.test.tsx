import type { ConfigResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ChannelsSettings } = await import('./ChannelsSettings.js');
const { api } = await import('../api.js');

// Partial fixtures — ConfigResponse has many required `has*: boolean` fields
// the component never reads. Double-cast through `unknown` is the standard
// escape for partial test stand-ins; the component is read-only against the
// shape and the mocked `api.updateConfig` doesn't echo back a real config.
const EMPTY_CONFIG = { provider: 'mock', channels: {} } as unknown as ConfigResponse;
const CONFIGURED_CONFIG = {
  provider: 'mock',
  channels: {
    webhook: { url: 'https://ntfy.sh/topic', method: 'POST' as const },
  },
} as unknown as ConfigResponse;

describe('ChannelsSettings', () => {
  beforeEach(() => {
    vi.mocked(api.listChannels).mockResolvedValue({ channels: [] } as never);
    vi.mocked(api.testChannel).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.updateConfig).mockImplementation(
      async (patch) => ({ ...EMPTY_CONFIG, ...patch }) as ConfigResponse,
    );
  });

  it('renders the empty status when no webhook is configured', async () => {
    render(<ChannelsSettings config={EMPTY_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Not configured.')).toBeInTheDocument();
    });
  });

  it('renders the active webhook URL when channels.listChannels reports it', async () => {
    vi.mocked(api.listChannels).mockResolvedValue({
      channels: [
        {
          name: 'webhook',
          configured: true,
          ready: true,
          detail: { url: 'https://ntfy.sh/topic' },
        },
      ],
    } as never);
    render(<ChannelsSettings config={CONFIGURED_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Active.*ntfy\.sh\/topic/)).toBeInTheDocument();
    });
  });

  it('saving a webhook with a URL calls updateConfig with channels.webhook set', async () => {
    const onConfigChanged = vi.fn();
    render(<ChannelsSettings config={EMPTY_CONFIG} onConfigChanged={onConfigChanged} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/ntfy\.sh\/your-topic/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/ntfy\.sh\/your-topic/), 'https://example.com/wh');
    await user.click(screen.getByRole('button', { name: /Save webhook/ }));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: expect.objectContaining({
            webhook: expect.objectContaining({
              url: 'https://example.com/wh',
              method: 'POST',
            }),
          }),
        }),
      );
    });
    expect(onConfigChanged).toHaveBeenCalled();
  });

  it('Save webhook is rejected (no API call) when URL is empty', async () => {
    render(<ChannelsSettings config={EMPTY_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save webhook/ })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Save webhook/ }));

    await waitFor(() => {
      expect(screen.getByText(/A URL is required/)).toBeInTheDocument();
    });
    expect(api.updateConfig).not.toHaveBeenCalled();
  });

  it('Send test message calls testChannel and shows success', async () => {
    vi.mocked(api.listChannels).mockResolvedValue({
      channels: [{ name: 'webhook', configured: true, ready: true }],
    } as never);

    render(<ChannelsSettings config={CONFIGURED_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Send test message/ })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Send test message/ }));

    await waitFor(() => {
      expect(api.testChannel).toHaveBeenCalledWith('webhook');
    });
    await waitFor(() => {
      expect(screen.getByText(/^Test sent\.$/)).toBeInTheDocument();
    });
  });

  it('failed test message surfaces the error inline', async () => {
    vi.mocked(api.listChannels).mockResolvedValue({
      channels: [{ name: 'webhook', configured: true, ready: true }],
    } as never);
    vi.mocked(api.testChannel).mockResolvedValue({ ok: false, error: '503 from ntfy' } as never);

    render(<ChannelsSettings config={CONFIGURED_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Send test message/ })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Send test message/ }));

    await waitFor(() => {
      expect(screen.getByText(/Test failed: 503 from ntfy/)).toBeInTheDocument();
    });
  });

  it('Remove button clears the webhook via updateConfig with webhook=undefined', async () => {
    vi.mocked(api.listChannels).mockResolvedValue({
      channels: [{ name: 'webhook', configured: true, ready: true }],
    } as never);

    render(<ChannelsSettings config={CONFIGURED_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Remove$/ })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Remove$/ }));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: expect.objectContaining({ webhook: undefined }),
          webhookBearerToken: '',
          webhookBasicAuth: '',
        }),
      );
    });
  });

  it('saving with bearer token includes webhookBearerToken in the patch', async () => {
    render(<ChannelsSettings config={EMPTY_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save webhook/ })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/ntfy\.sh\/your-topic/), 'https://example.com/wh');
    await user.type(screen.getByPlaceholderText('Paste bearer token'), 'tok-abc123');
    await user.click(screen.getByRole('button', { name: /Save webhook/ }));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ webhookBearerToken: 'tok-abc123' }),
      );
    });
  });
});
