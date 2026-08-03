import type { CopilotAvailability } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { CopilotInstallCard } = await import('./CopilotInstallCard.js');

function availability(overrides: Partial<CopilotAvailability>): CopilotAvailability {
  return {
    available: false,
    source: null,
    managed: 'absent',
    pinnedVersion: '1.0.7',
    updateAvailable: false,
    ...overrides,
  };
}

/**
 * The damaged branch is the repair affordance the provider's "choose Repair"
 * error points at. Before it existed, a broken-but-present install rendered
 * the plain "Installed" line with no button — Settings and Test connection
 * contradicted each other and the user had nowhere to go.
 */
describe('CopilotInstallCard', () => {
  it('offers a Repair button with the reason when the managed install is damaged', () => {
    render(
      <CopilotInstallCard
        availability={availability({
          managed: 'damaged',
          installedVersion: '1.0.7',
          damagedReason: 'entry file "dist/cjs/index.js" is missing from the install',
        })}
      />,
    );
    expect(screen.getByText(/files are damaged/)).toBeTruthy();
    expect(screen.getByText(/dist\/cjs\/index\.js/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Repair' })).toBeTruthy();
  });

  it('shows the plain installed line, with no button, when the install is healthy', () => {
    render(
      <CopilotInstallCard
        availability={availability({
          available: true,
          source: 'managed',
          managed: 'current',
          installedVersion: '1.0.7',
        })}
      />,
    );
    expect(screen.getByText(/Installed — GitHub Copilot SDK 1\.0\.7/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
