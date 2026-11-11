import type { ProjectTypeUpgradePlan } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';
import { primitivesMock } from '../../test-utils/primitivesMock.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../primitives/index.js', () => primitivesMock);

const {
  ProjectTypeUpdateDialog,
  ProjectTypeUpdateNotice,
  projectTypeUpdateAsks,
  projectTypeUpdateKeeps,
} = await import('./ProjectTypeUpdate.js');
const { api } = await import('../../api.js');

function plan(overrides: Partial<ProjectTypeUpgradePlan> = {}): ProjectTypeUpgradePlan {
  return {
    projectId: 'cafe',
    typeId: 'shift-roster',
    typeName: 'Shift Roster',
    source: 'bundled',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    automatic: false,
    needsOk: [{ kind: 'edited-script', items: ['roster-store'] }],
    changes: {
      page: true,
      scripts: [{ name: 'roster-store', change: 'replace-edited' }],
      seeds: [],
      craftbooks: [],
      about: 'keep-edited',
      mission: 'unchanged',
      crew: [],
      toolsets: [],
      schedules: [],
      settings: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('app update wording', () => {
  it('says what the person is agreeing to and what stays', () => {
    expect(projectTypeUpdateAsks(plan())).toEqual([
      'Replaces a script changed in this project (roster-store). A copy is saved first in Artifacts, under app-updates.',
    ]);
    expect(projectTypeUpdateKeeps(plan())).toEqual([
      'Your data stays as it is.',
      'Your About this project text stays.',
    ]);
    expect(
      projectTypeUpdateAsks(
        plan({
          needsOk: [
            { kind: 'new-crew', items: ['helper'] },
            { kind: 'folder-write', items: ['rules.json', 'notes.json'] },
          ],
        }),
      ),
    ).toEqual([
      'Adds a crew member this version works with.',
      'Adds 2 files to your folder (rules.json, notes.json).',
    ]);
  });
});

describe('ProjectTypeUpdateNotice', () => {
  it('opens the review from one muted line', () => {
    const onReview = vi.fn();
    render(<ProjectTypeUpdateNotice plan={plan()} onReview={onReview} />);
    expect(screen.getByText('An update for Shift Roster is ready.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update…' }));
    expect(onReview).toHaveBeenCalled();
  });
});

describe('ProjectTypeUpdateDialog', () => {
  it('approves the version it showed and reports back', async () => {
    const applied = { typeId: 'shift-roster', version: '1.1.0', upgradedFrom: '1.0.0' };
    vi.mocked(api.upgradeProjectType).mockResolvedValue(applied as never);
    const onUpdated = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ProjectTypeUpdateDialog
        projectId="cafe"
        plan={plan()}
        open
        onOpenChange={onOpenChange}
        onUpdated={onUpdated}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Update Shift Roster?' })).toBeInTheDocument();
    expect(screen.queryByText(/1\.0\.0/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(applied));
    expect(api.upgradeProjectType).toHaveBeenCalledWith('cafe', { toVersion: '1.1.0' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows a refusal inline and stays open', async () => {
    vi.mocked(api.upgradeProjectType).mockRejectedValue(
      new Error('The update on offer is now version 1.2.0.'),
    );
    const onOpenChange = vi.fn();
    render(
      <ProjectTypeUpdateDialog
        projectId="cafe"
        plan={plan()}
        open
        onOpenChange={onOpenChange}
        onUpdated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('now version 1.2.0');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
