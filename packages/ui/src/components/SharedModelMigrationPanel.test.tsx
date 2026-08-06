import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { SharedModelMigrationPanel } = await import('./SharedModelMigrationPanel.js');
const { api } = await import('../api.js');

const candidate = {
  source: 'development' as const,
  sourceLabel: 'Development Gezel data',
  engine: 'mlx' as const,
  id: 'gemma-test-4b',
  name: 'Gemma Test 4B',
  approxSizeBytes: 4_200_000_000,
  catalogVersion: '1.2.3',
  moving: false,
};

describe('SharedModelMigrationPanel', () => {
  beforeEach(() => {
    vi.mocked(api.listSharedModelMigrationCandidates).mockResolvedValue({
      available: false,
      candidates: [],
    });
    vi.mocked(api.moveModelToShared).mockReset();
  });

  it('stays hidden when no connected shared-store migration is available', async () => {
    const { container } = render(<SharedModelMigrationPanel engine="mlx" />);
    await waitFor(() => expect(api.listSharedModelMigrationCandidates).toHaveBeenCalledWith('mlx'));
    expect(container).toBeEmptyDOMElement();
  });

  it('restores an in-progress move when the panel mounts again', async () => {
    vi.mocked(api.listSharedModelMigrationCandidates).mockResolvedValue({
      available: true,
      candidates: [{ ...candidate, moving: true }],
    });

    render(<SharedModelMigrationPanel engine="mlx" />);

    expect(await screen.findByRole('button', { name: 'Moving and verifying…' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Move to shared location' }),
    ).not.toBeInTheDocument();
    expect(api.moveModelToShared).not.toHaveBeenCalled();
  });

  it('confirms the move, reports success, and publishes a model-change event', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listSharedModelMigrationCandidates)
      .mockResolvedValueOnce({ available: true, candidates: [candidate] })
      .mockResolvedValue({ available: true, candidates: [] });
    vi.mocked(api.moveModelToShared).mockResolvedValue({
      ok: true,
      engine: 'mlx',
      id: candidate.id,
      localRemoved: true,
    });
    const changed = vi.fn();
    window.addEventListener('gezel:models-changed', changed);

    render(<SharedModelMigrationPanel engine="mlx" />);
    await user.click(await screen.findByRole('button', { name: 'Move to shared location' }));
    expect(await screen.findByRole('heading', { name: /Move Gemma Test 4B/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move model' }));

    await waitFor(() => {
      expect(api.moveModelToShared).toHaveBeenCalledWith({
        source: 'development',
        engine: 'mlx',
        id: candidate.id,
      });
    });
    expect(
      await screen.findByText('Gemma Test 4B is now in the shared model library.'),
    ).toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
    window.removeEventListener('gezel:models-changed', changed);
  });

  it('reconciles an already-moving race without showing an error', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listSharedModelMigrationCandidates)
      .mockResolvedValueOnce({ available: true, candidates: [candidate] })
      .mockResolvedValue({ available: true, candidates: [{ ...candidate, moving: true }] });
    vi.mocked(api.moveModelToShared).mockRejectedValue(
      new Error('this model is already being moved'),
    );

    render(<SharedModelMigrationPanel engine="mlx" />);
    await user.click(await screen.findByRole('button', { name: 'Move to shared location' }));
    await user.click(screen.getByRole('button', { name: 'Move model' }));

    expect(await screen.findByRole('button', { name: 'Moving and verifying…' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
