import type { GezelSummary, ProjectDetail } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./useRoleBasedNameOnlyMode.js', () => ({
  useRoleBasedNameOnlyMode: () => false,
}));
vi.mock('./GezelIcon.js', () => ({ GezelIcon: () => <span data-testid="gezel-icon" /> }));

const { ProjectCrewRoster } = await import('./ProjectCrewRoster.js');

const BOOK = {
  id: 'noor',
  name: 'Noor',
  role: 'Boekwachter',
  templateId: 'boekwachter',
  updatedAt: '2026-07-30T00:00:00.000Z',
} as GezelSummary;

function project(gezelIds: string[]): ProjectDetail {
  return {
    id: 'atlas',
    name: 'Atlas',
    gezelIds,
  } as ProjectDetail;
}

describe('ProjectCrewRoster autonomous roles', () => {
  it('offers the designated Boekwachter when AI indexing is off', async () => {
    const onAddGezel = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectCrewRoster
        project={project([])}
        gezels={[BOOK]}
        boekwachterGezelId={BOOK.id}
        onAddGezel={onAddGezel}
      />,
    );

    expect(screen.getByText('AI indexing off')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Noor' }));
    await waitFor(() => expect(onAddGezel).toHaveBeenCalledWith('noor'));
  });

  it('makes removal the explicit off switch when the role is present', async () => {
    const onRemoveGezel = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectCrewRoster
        project={project(['noor'])}
        gezels={[BOOK]}
        boekwachterGezelId={BOOK.id}
        onRemoveGezel={onRemoveGezel}
      />,
    );

    expect(screen.getByText('AI indexing on')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Boekwachter' }));
    await waitFor(() => expect(onRemoveGezel).toHaveBeenCalledWith('noor'));
  });
});
