import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('./FindSimilarImages.js', () => ({
  BlobThumb: ({ alt }: { alt: string }) => <span data-testid="person-photo">{alt}</span>,
}));
vi.mock('./ConfirmDialog.js', () => ({
  ConfirmDialog: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    message?: ReactNode;
    confirmLabel?: string;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <p>{message}</p>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel ?? 'Confirm'}
        </button>
      </div>
    ) : null,
}));

const { api } = await import('../api.js');
const { PeoplePanel } = await import('./PeoplePanel.js');

const anonymousPerson = {
  entityId: 17,
  label: 'Person 1',
  clusterId: 'face-cluster-17',
  count: 2,
  exemplar: { path: 'photos/person-1.jpg' },
  samples: [{ path: 'photos/person-1.jpg' }, { path: 'photos/person-1-again.jpg' }],
};

describe('PeoplePanel', () => {
  beforeEach(() => {
    vi.mocked(api.listPeople).mockResolvedValue({ available: true, people: [anonymousPerson] });
    vi.mocked(api.renamePerson).mockResolvedValue({ ok: true });
    vi.mocked(api.forgetPerson).mockResolvedValue({ ok: true });
  });

  it('stays out of the project when recognition is unavailable', async () => {
    vi.mocked(api.listPeople).mockResolvedValueOnce({ available: false, people: [] });
    const { container } = render(<PeoplePanel projectId="project-1" />);

    await waitFor(() => expect(api.listPeople).toHaveBeenCalledWith('project-1'));
    expect(container).toBeEmptyDOMElement();
  });

  it('renames an anonymous person and refreshes the project list', async () => {
    vi.mocked(api.listPeople)
      .mockResolvedValueOnce({ available: true, people: [anonymousPerson] })
      .mockResolvedValueOnce({
        available: true,
        people: [{ ...anonymousPerson, label: 'Ada' }],
      });
    render(<PeoplePanel projectId="project-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Person 1' }));
    const input = screen.getByRole('textbox', { name: 'Name for Person 1' });
    expect(input).toHaveValue('');
    await userEvent.type(input, 'Ada{Enter}');

    await waitFor(() => expect(api.renamePerson).toHaveBeenCalledWith('project-1', 17, 'Ada'));
    expect(await screen.findByRole('button', { name: 'Ada' })).toBeInTheDocument();
  });

  it('forgets a person only after confirmation and refreshes the list', async () => {
    vi.mocked(api.listPeople)
      .mockResolvedValueOnce({ available: true, people: [anonymousPerson] })
      .mockResolvedValueOnce({ available: true, people: [] });
    render(<PeoplePanel projectId="project-1" />);

    await screen.findByRole('button', { name: 'Person 1' });
    await userEvent.click(screen.getByRole('button', { name: 'Forget' }));
    expect(api.forgetPerson).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Forget Person 1?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Forget' }));

    await waitFor(() => expect(api.forgetPerson).toHaveBeenCalledWith('project-1', 17));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'People' })).not.toBeInTheDocument(),
    );
  });
});
