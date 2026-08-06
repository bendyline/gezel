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
    expect(
      screen.getByText(/Custom posture — individual capabilities below differ/),
    ).toBeInTheDocument();
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
