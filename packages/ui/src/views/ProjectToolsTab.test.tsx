import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const { updatedProject } = vi.hoisted(() => ({
  updatedProject: {
    id: 'p1',
    name: 'Winkel',
    packages: [
      { name: 'lodash', version: '4.17.21' },
      { name: 'zod', version: '4.1.0' },
    ],
  },
}));

vi.mock('../api.js', () => ({
  api: createMockApi({
    listPackageScripts: vi.fn().mockResolvedValue({ scripts: { test: 'vitest run' } }),
    getProjectApprovals: vi.fn().mockResolvedValue({
      npmApproved: [
        { package: 'lodash', version: '4.17.21', approvedBy: 'user' },
        { package: 'typescript', version: '5.9.0', approvedBy: 'shipped' },
      ],
      npmDeclined: [{ package: 'left-pad', version: '1.3.0', at: '2026-09-01T00:00:00Z' }],
      scriptApprovals: { test: 'approved', deploy: 'declined' },
      npxApprovals: {},
      npmShipped: [],
    }),
    installPackage: vi.fn().mockResolvedValue({ project: updatedProject, log: 'added 1 package' }),
  }),
}));

import { api } from '../api.js';
import { ProjectToolsTab } from './ProjectToolsTab.js';

const project = {
  id: 'p1',
  name: 'Winkel',
  packages: [{ name: 'lodash', version: '4.17.21' }],
} as never;

describe('ProjectToolsTab', () => {
  it('lists packages, scripts, and each approval decision with its badge', async () => {
    render(<ProjectToolsTab project={project} onProjectChange={vi.fn()} />);

    const scripts = screen.getByRole('region', { name: 'Scripts' });
    expect(await within(scripts).findByText('vitest run')).toBeInTheDocument();

    const approvals = screen.getByRole('region', { name: 'Approvals' });
    const row = async (name: string) =>
      (await within(approvals).findByText(name)).closest('li') as HTMLElement;
    expect(within(await row('typescript')).getByText('Allowed by default')).toBeInTheDocument();
    expect(within(await row('left-pad')).getByText('Declined')).toBeInTheDocument();
    expect(within(await row('deploy')).getByText('Declined')).toBeInTheDocument();
    expect(within(await row('test')).getByText('Approved')).toBeInTheDocument();
    expect(within(approvals).queryByText('npx commands')).not.toBeInTheDocument();
  });

  it('installs on Enter and hands the updated project back', async () => {
    const onProjectChange = vi.fn();
    render(<ProjectToolsTab project={project} onProjectChange={onProjectChange} />);

    const input = screen.getByRole('textbox', { name: 'npm package to install' });
    const install = screen.getByRole('button', { name: 'Install' });
    expect(install).toBeDisabled();

    fireEvent.change(input, { target: { value: ' zod ' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith(updatedProject));
    expect(api.installPackage).toHaveBeenCalledWith('p1', { name: 'zod' });
    expect(screen.getByText('added 1 package')).toBeInTheDocument();
    expect(input).toHaveValue('');
  });
});
