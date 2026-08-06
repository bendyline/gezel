import type { Project } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { ProjectActionsMenu, ProjectContextMenu } = await import('./ProjectActionsMenu.js');
const { api } = await import('../api.js');

const PROJECT = { id: 'p1', name: 'Alpha' } as Project;

describe('ProjectActionsMenu', () => {
  beforeEach(() => {
    vi.mocked(api.clearProjectErrors).mockResolvedValue({ cleared: 2 } as never);
    vi.mocked(api.revealProject).mockResolvedValue({ ok: true, path: '/tmp/project' });
  });

  it('offers no error-clearing action when the project has no failed turn', () => {
    render(<ProjectActionsMenu project={PROJECT} />);
    expect(screen.queryByRole('menuitem', { name: 'Clear error indicator' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Open workspace folder' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open artifacts folder' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete project…' })).toBeInTheDocument();
  });

  it('opens the project workspace and artifacts folders in the OS file manager', async () => {
    render(<ProjectActionsMenu project={PROJECT} />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open workspace folder' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open artifacts folder' }));

    await waitFor(() => {
      expect(api.revealProject).toHaveBeenCalledWith('p1', 'workspace');
      expect(api.revealProject).toHaveBeenCalledWith('p1', 'artifacts');
    });
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

  it('offers the same project actions from a row context menu', () => {
    render(
      <ProjectContextMenu project={PROJECT}>
        <button type="button">Alpha project row</button>
      </ProjectContextMenu>,
    );

    expect(screen.queryByRole('menuitem', { name: 'Delete project…' })).toBeNull();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha project row' }));
    expect(screen.getByRole('menuitem', { name: 'Open workspace folder' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open artifacts folder' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete project…' })).toBeInTheDocument();
  });
});
