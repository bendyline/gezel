import type { Project } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { ProjectActionsMenu } = await import('./ProjectActionsMenu.js');
const { api } = await import('../api.js');

const PROJECT = { id: 'p1', name: 'Alpha' } as Project;

describe('ProjectActionsMenu', () => {
  beforeEach(() => {
    vi.mocked(api.clearProjectErrors).mockResolvedValue({ cleared: 2 } as never);
  });

  it('offers no error-clearing action when the project has no failed turn', () => {
    render(<ProjectActionsMenu project={PROJECT} />);
    expect(screen.queryByRole('menuitem', { name: 'Clear error indicator' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete project…' })).toBeInTheDocument();
  });

  it('clears the project error and announces it so the sidebar indicator drops', async () => {
    const cleared = vi.fn();
    window.addEventListener('gezel:session-error-cleared', cleared);
    render(<ProjectActionsMenu project={PROJECT} hasError />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear error indicator' }));

    await waitFor(() => expect(api.clearProjectErrors).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(cleared).toHaveBeenCalled());
    const event = cleared.mock.calls[0]?.[0] as CustomEvent<{ projectId: string }>;
    expect(event.detail).toEqual({ projectId: 'p1' });
    window.removeEventListener('gezel:session-error-cleared', cleared);
  });
});
