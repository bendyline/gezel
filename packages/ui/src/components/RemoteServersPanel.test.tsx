import { GezelApiError } from '@bendyline/gezel-client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SERVER_FP = 'a1b2'.repeat(16);
const OWN_FP = 'f0f0'.repeat(16);

const api = {
  getBaseUrl: () => 'http://127.0.0.1:3333',
  authHeader: () => ({ Authorization: 'Bearer test-token' }),
  listRemotes: vi.fn(),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getMachineServing: vi.fn(),
  listLanAddresses: vi.fn(),
  discoverRemotes: vi.fn(),
  getPairingCode: vi.fn(),
  openPairingCode: vi.fn(),
  closePairingCode: vi.fn(),
  inspectRemote: vi.fn(),
  pairRemoteWithCode: vi.fn(),
  pairRemote: vi.fn(),
  unpairRemote: vi.fn(),
};

vi.mock('../api.js', () => ({ api }));

const { RemoteServersPanel } = await import('./RemoteServersPanel.js');

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/v1/identity')) {
        return new Response(JSON.stringify({ deviceId: 'me', fingerprint: OWN_FP }));
      }
      if (url.endsWith('/v1/apps')) return new Response(JSON.stringify({ apps: [], grants: [] }));
      return new Response('{}', { status: 404 });
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stubFetch();
  api.listRemotes.mockResolvedValue({ remotes: [] });
  api.getConfig.mockResolvedValue({ remoteServing: { enabled: true, port: 6229 } });
  api.getMachineServing.mockRejectedValue(new Error('503'));
  api.listLanAddresses.mockResolvedValue({
    addresses: [
      { address: '192.168.1.23', interfaceName: 'Wi-Fi' },
      { address: '172.29.16.1', interfaceName: 'vEthernet (WSL)' },
    ],
  });
  api.discoverRemotes.mockResolvedValue({
    available: true,
    servers: [
      {
        name: 'Werkbank',
        fingerprint: SERVER_FP,
        address: '192.168.1.20',
        port: 6229,
        baseUrl: 'https://192.168.1.20:6229',
        lastSeenAt: Date.now(),
      },
    ],
  });
  api.getPairingCode.mockResolvedValue({ code: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteServersPanel — sharing', () => {
  it('shows the address other devices connect to while sharing is on', async () => {
    render(<RemoteServersPanel />);
    expect(await screen.findByText('https://192.168.1.23:6229')).toBeTruthy();
    expect(screen.getByText('172.29.16.1')).toBeTruthy();
  });

  it('shows a connect code on Add a device', async () => {
    api.openPairingCode.mockResolvedValue({
      code: '48210937',
      expiresAt: Date.now() + 300_000,
      attemptsLeft: 5,
    });
    render(<RemoteServersPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a device' }));
    expect(await screen.findByText('4821 0937')).toBeTruthy();
    expect(screen.getByText(/expires in 5:00|expires in 4:59/)).toBeTruthy();
  });

  it('keeps port and limits behind Advanced', async () => {
    render(<RemoteServersPanel />);
    const port = await screen.findByLabelText('Server port');
    expect(port.closest('details')?.querySelector('summary')?.textContent).toBe('Advanced');
  });
});

describe('RemoteServersPanel — connecting', () => {
  it('lists a device found on the network and connects to it with its code', async () => {
    api.inspectRemote.mockResolvedValue({
      deviceId: 'srv',
      fingerprint: SERVER_FP,
      identityChanged: false,
      pairingMethods: ['code', 'approval'],
    });
    api.pairRemoteWithCode.mockResolvedValue({
      remote: { remoteId: SERVER_FP, displayName: 'Werkbank' },
    });
    render(<RemoteServersPanel />);
    const row = (await screen.findByText('Werkbank')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Connect' }));

    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('Connect code');
    fireEvent.change(field, { target: { value: '48210937' } });
    expect((field as HTMLInputElement).value).toBe('4821 0937');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(api.pairRemoteWithCode).toHaveBeenCalledWith({
        baseUrl: 'https://192.168.1.20:6229',
        code: '4821 0937',
      }),
    );
    expect(await screen.findByText(/Connected to Werkbank/)).toBeTruthy();
  });

  it('says why a code was refused and keeps the dialog open', async () => {
    api.inspectRemote.mockResolvedValue({
      deviceId: 'srv',
      fingerprint: SERVER_FP,
      identityChanged: false,
      pairingMethods: ['code', 'approval'],
    });
    api.pairRemoteWithCode.mockRejectedValue(
      new GezelApiError('Gezel API error 403', 403, {
        error: 'pairing_code_rejected',
        message: "That code doesn't match. Check the code on the other device and try again.",
      }),
    );
    render(<RemoteServersPanel />);
    const row = (await screen.findByText('Werkbank')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Connect code'), {
      target: { value: '00000000' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog).findByText(/That code doesn't match/)).toBeTruthy();
  });

  it('falls back to comparing the identity code for a server that predates codes', async () => {
    api.inspectRemote.mockResolvedValue({
      deviceId: 'srv',
      fingerprint: SERVER_FP,
      identityChanged: false,
      pairingMethods: ['approval'],
    });
    render(<RemoteServersPanel />);
    const row = (await screen.findByText('Werkbank')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Check the identity code')).toBeTruthy();
    expect(screen.getByText('a1b2 a1b2 a1b2 a1b2')).toBeTruthy();
  });

  it('connects by a bare IP address on the default port', async () => {
    api.inspectRemote.mockResolvedValue({
      deviceId: 'srv',
      fingerprint: SERVER_FP,
      identityChanged: false,
      pairingMethods: ['code'],
    });
    render(<RemoteServersPanel />);
    fireEvent.change(await screen.findByLabelText('Server IP address'), {
      target: { value: '192.168.1.50' },
    });
    const form = screen.getByLabelText('Server IP address').closest('form')!;
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(api.inspectRemote).toHaveBeenCalledWith({ baseUrl: 'https://192.168.1.50:6229' }),
    );
  });

  it('says plainly when a remembered server is away, without treating it as an error', async () => {
    api.discoverRemotes.mockResolvedValue({ available: true, servers: [] });
    api.listRemotes.mockResolvedValue({
      remotes: [
        {
          remoteId: SERVER_FP,
          baseUrl: 'https://192.168.1.20:6229',
          displayName: 'Werkbank',
          pinnedIdentityFingerprint: SERVER_FP,
          scopes: ['remote-inference'],
          pairedAt: 1,
          hasToken: true,
          status: 'offline',
        },
      ],
    });
    render(<RemoteServersPanel />);
    expect(
      await screen.findByText(/not reachable — gezellen answer without it until it's back/),
    ).toBeTruthy();
    expect(api.listRemotes).toHaveBeenCalledWith({ check: true });
  });

  it('remembers connected servers and marks the ones on the network now', async () => {
    api.discoverRemotes.mockResolvedValue({
      available: true,
      servers: [
        {
          name: 'Werkbank',
          fingerprint: SERVER_FP,
          address: '192.168.1.20',
          port: 6229,
          baseUrl: 'https://192.168.1.20:6229',
          lastSeenAt: Date.now(),
          pairedRemoteId: SERVER_FP,
        },
      ],
    });
    api.listRemotes.mockResolvedValue({
      remotes: [
        {
          remoteId: SERVER_FP,
          baseUrl: 'https://192.168.1.20:6229',
          displayName: 'Werkbank',
          pinnedIdentityFingerprint: SERVER_FP,
          scopes: ['remote-inference'],
          pairedAt: 1,
          hasToken: true,
        },
      ],
    });
    render(<RemoteServersPanel />);
    expect(await screen.findByText(/on your network now/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forget' })).toBeTruthy();
    // The same server in the network list reads as connected, not as a Connect key.
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
  });
});
