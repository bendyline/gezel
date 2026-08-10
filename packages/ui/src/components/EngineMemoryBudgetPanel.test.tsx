import type { EngineStatusResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { EngineMemoryBudgetPanel } from './EngineMemoryBudgetPanel.js';

vi.mock('../api.js', () => ({
  api: {
    updateEngineMemoryBudget: vi.fn(),
    updateEngineRamSpillover: vi.fn(),
  },
}));

const GB = 1024 ** 3;

function status(overrides: Partial<EngineStatusResponse> = {}): EngineStatusResponse {
  return {
    enforced: true,
    budgetBytes: 68 * GB,
    committedBytes: 0,
    entries: [],
    systemRamBytes: 64 * GB,
    autoBudgetBytes: 68 * GB,
    overridden: false,
    pools: {
      kind: 'discrete-gpu',
      vramBytes: 30 * GB,
      ramShareBytes: 38 * GB,
      fastBytes: 30 * GB,
    },
    ramSpillover: { allowed: false, auto: false, overridden: false, coResidencyBytes: 30 * GB },
    ...overrides,
  };
}

describe('EngineMemoryBudgetPanel — RAM spillover', () => {
  beforeEach(() => {
    vi.mocked(api.updateEngineMemoryBudget).mockReset();
    vi.mocked(api.updateEngineMemoryBudget).mockResolvedValue({} as never);
    vi.mocked(api.updateEngineRamSpillover).mockReset();
    vi.mocked(api.updateEngineRamSpillover).mockResolvedValue({} as never);
  });

  it('latches Automatic until the user picks a side', async () => {
    render(<EngineMemoryBudgetPanel status={status()} onSaved={() => {}} />);

    expect(screen.getByRole('radio', { name: 'Automatic' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Unload one' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // The host's own answer is stated, so "Automatic" isn't a black box.
    expect(screen.getByText(/On this machine that means unloading one/)).toBeInTheDocument();
    expect(screen.getByText(/concurrent models stay within graphics memory/)).toBeInTheDocument();
  });

  it('saves an explicit choice and reflects the override', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const { rerender } = render(<EngineMemoryBudgetPanel status={status()} onSaved={onSaved} />);

    await user.click(screen.getByRole('radio', { name: 'Use system memory' }));

    await waitFor(() => {
      expect(api.updateEngineRamSpillover).toHaveBeenCalledWith(true);
      expect(onSaved).toHaveBeenCalled();
    });

    rerender(
      <EngineMemoryBudgetPanel
        status={status({
          ramSpillover: { allowed: true, auto: false, overridden: true, coResidencyBytes: 68 * GB },
        })}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Use system memory' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('returns to the host default when Automatic is picked again', async () => {
    const user = userEvent.setup();
    render(
      <EngineMemoryBudgetPanel
        status={status({
          ramSpillover: { allowed: true, auto: false, overridden: true, coResidencyBytes: 68 * GB },
        })}
        onSaved={() => {}}
      />,
    );

    await user.click(screen.getByRole('radio', { name: 'Automatic' }));

    await waitFor(() => {
      expect(api.updateEngineRamSpillover).toHaveBeenCalledWith(null);
    });
  });

  it('stays hidden on a host with one memory pool', () => {
    render(
      <EngineMemoryBudgetPanel
        status={status({
          pools: { kind: 'unified', vramBytes: 0, ramShareBytes: 68 * GB, fastBytes: 68 * GB },
        })}
        onSaved={() => {}}
      />,
    );

    expect(screen.queryByRole('radio', { name: 'Unload one' })).not.toBeInTheDocument();
    // The budget slider it sits under is still there.
    expect(screen.getByLabelText('Memory for on-device models')).toBeInTheDocument();
  });

  it('stays hidden against a daemon that predates the field', () => {
    const older = status();
    older.ramSpillover = undefined;
    render(<EngineMemoryBudgetPanel status={older} onSaved={() => {}} />);

    expect(screen.queryByRole('radio', { name: 'Automatic' })).not.toBeInTheDocument();
  });
});
