import { securityPolicyForLevel } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { SecurityComplianceSettings } = await import('./SecurityComplianceSettings.js');
const { api } = await import('../api.js');

// Partial fixtures — ConfigResponse has many required fields the component
// never reads; double-cast through `unknown` is the standard test stand-in.
function configWithPolicy(policy: ConfigResponse['securityPolicy']): ConfigResponse {
  return { provider: 'mock', securityPolicy: policy } as unknown as ConfigResponse;
}

describe('SecurityComplianceSettings', () => {
  it('renders the posture radiogroup with exactly one latched preset', () => {
    render(
      <SecurityComplianceSettings
        config={configWithPolicy(securityPolicyForLevel('lockdown'))}
        onConfigChanged={vi.fn()}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Security posture' });
    expect(group).toHaveClass('gz-tray');

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    const latched = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(latched).toHaveLength(1);
    expect(latched[0]).toHaveTextContent('Lockdown');
    expect(latched[0]).toHaveClass('gz-key-active');
    for (const r of radios) expect(r).toHaveClass('gz-key');
  });

  it('selecting a preset persists that preset policy', async () => {
    const onConfigChanged = vi.fn();
    vi.mocked(api.updateConfig).mockImplementation(async (patch) =>
      configWithPolicy(patch.securityPolicy),
    );
    render(
      <SecurityComplianceSettings
        config={configWithPolicy(securityPolicyForLevel('lockdown'))}
        onConfigChanged={onConfigChanged}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Unrestricted' }));
    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        securityPolicy: securityPolicyForLevel('free'),
      });
    });
    expect(onConfigChanged).toHaveBeenCalled();
  });

  it('a custom mix latches an inert Custom key and no preset', () => {
    const custom = { ...securityPolicyForLevel('lockdown'), level: 'custom' as const };
    custom.allowFileEdits = false;
    render(
      <SecurityComplianceSettings config={configWithPolicy(custom)} onConfigChanged={vi.fn()} />,
    );
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    const customKey = screen.getByRole('radio', { name: 'Custom' });
    expect(customKey).toBeDisabled();
    expect(customKey).toHaveAttribute('aria-checked', 'true');
    expect(customKey).toHaveClass('gz-key-active', 'gz-key-state');
    for (const r of radios.filter((x) => x !== customKey)) {
      expect(r).toHaveAttribute('aria-checked', 'false');
    }
    // The description panel leads with the latched mode's name in bold
    // (described-tray pattern), so the label and the copy are separate nodes.
    const description = screen.getByText(/individual capabilities below differ/);
    expect(description).toBeInTheDocument();
    expect(description.closest('p')?.querySelector('strong')?.textContent).toBe('Custom');
  });

  it('flipping a capability off-preset persists a Custom-classified policy', async () => {
    const onConfigChanged = vi.fn();
    vi.mocked(api.updateConfig).mockImplementation(async (patch) =>
      configWithPolicy(patch.securityPolicy),
    );
    render(
      <SecurityComplianceSettings
        config={configWithPolicy(securityPolicyForLevel('lockdown'))}
        onConfigChanged={onConfigChanged}
      />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /Edit files/ }));
    const { level: _lockdown, ...lockdownCaps } = securityPolicyForLevel('lockdown');
    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        securityPolicy: { level: 'custom', ...lockdownCaps, allowFileEdits: false },
      });
    });
    await waitFor(() => expect(onConfigChanged).toHaveBeenCalled());
    expect(screen.queryByText(/^saved$/i)).not.toBeInTheDocument();
  });
});

describe('Windows sandbox setting', () => {
  const withSandbox = (scriptSandbox: Record<string, unknown>) =>
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      version: 'test',
      scriptSandbox,
    } as unknown as Awaited<ReturnType<typeof api.health>>);

  it('stays hidden where the daemon reports no Windows sandbox', async () => {
    vi.mocked(api.health).mockResolvedValue({ ok: true, version: 'test' } as Awaited<
      ReturnType<typeof api.health>
    >);
    render(
      <SecurityComplianceSettings
        config={configWithPolicy(securityPolicyForLevel('lockdown'))}
        onConfigChanged={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.health).toHaveBeenCalled());
    expect(screen.queryByText('Windows sandbox')).not.toBeInTheDocument();
  });

  it('says why the sandbox is unavailable on this PC', async () => {
    withSandbox({
      boundary: 'windows-mxc',
      state: 'unavailable',
      reason: 'the Windows sandbox launcher is not installed',
    });
    render(
      <SecurityComplianceSettings
        config={configWithPolicy(securityPolicyForLevel('lockdown'))}
        onConfigChanged={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(
        'Not available on this PC: the Windows sandbox launcher is not installed.',
      ),
    ).toBeInTheDocument();
  });

  it('turns the sandbox off and reports the new state', async () => {
    withSandbox({ boundary: 'windows-mxc', state: 'active', tier: 'base-container' });
    const onConfigChanged = vi.fn();
    vi.mocked(api.updateConfig).mockImplementation(async (patch) => {
      withSandbox({ boundary: 'windows-mxc', state: 'disabled', reason: 'turned off in Settings' });
      return {
        ...configWithPolicy(securityPolicyForLevel('lockdown')),
        ...patch,
      } as ConfigResponse;
    });
    render(
      <SecurityComplianceSettings
        config={configWithPolicy(securityPolicyForLevel('lockdown'))}
        onConfigChanged={onConfigChanged}
      />,
    );
    expect(await screen.findByText('Active on this PC.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /Windows sandbox/ }));
    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({ scriptSandbox: { windowsContainer: false } }),
    );
    expect(await screen.findByText('Off.')).toBeInTheDocument();
    expect(onConfigChanged).toHaveBeenCalled();
  });
});
