import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { GEZEL_REMOVAL_EUPHEMISMS, GezelActionsMenu, randomGezelRemovalEuphemism } = await import(
  './GezelActionsMenu.js'
);
const { api } = await import('../api.js');

describe('GezelActionsMenu', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(api.deleteGezel).mockResolvedValue({ ok: true, id: 'maya', name: 'Maya' });
  });

  it('can choose every playful removal label', () => {
    for (const [index, label] of GEZEL_REMOVAL_EUPHEMISMS.entries()) {
      vi.mocked(Math.random).mockReturnValue((index + 0.1) / GEZEL_REMOVAL_EUPHEMISMS.length);
      expect(randomGezelRemovalEuphemism()).toBe(label);
    }
  });

  it('warns that removal is permanent before deleting the gezel', async () => {
    const onDeleted = vi.fn();
    render(<GezelActionsMenu gezel={{ id: 'maya', name: 'Maya' }} onDeleted={onDeleted} />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Retire gezel…' }));
    expect(screen.getByRole('heading', { name: 'Retire Maya?' })).toBeInTheDocument();
    expect(screen.getByText(/permanently remove Maya/)).toBeInTheDocument();
    expect(screen.getByText(/won't be able to get this gezel back/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retire Maya' }));
    await waitFor(() => expect(api.deleteGezel).toHaveBeenCalledWith('maya'));
    expect(onDeleted).toHaveBeenCalledWith('maya');
  });

  it('does not offer account-local removal for a machine-shared gezel', () => {
    const { container } = render(
      <GezelActionsMenu gezel={{ id: 'maya', name: 'Maya', storageScope: 'machine-shared' }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
