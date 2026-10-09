import type { CatalogItemSummary, Project } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';
import { deriveLaunchProjectId } from './utils.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../tasks/NewTaskDialog.js', () => ({
  NewTaskDialog: (props: {
    initialCraftbookId?: string;
    defaultProjectId: string;
    quickLaunch: boolean;
  }) => <output>{JSON.stringify(props)}</output>,
}));
const { api } = await import('../../api.js');
const { MakeSomething } = await import('./MakeSomething.js');
const projects = [
  { id: 'default', name: 'Default' },
  { id: 'garden', name: 'Garden' },
] as Project[];
const item = (id: string) =>
  ({
    sourceId: 'bundled',
    kind: 'craftbook-template',
    manifest: {
      id,
      kind: 'craftbook-template',
      name: id,
      description: 'A useful result',
      steps: [],
      tags: [],
    },
  }) as unknown as CatalogItemSummary;

beforeEach(() => {
  vi.mocked(api.listProjectCraftbooks)
    .mockReset()
    .mockResolvedValue({
      items: [item('research-report'), item('powerpoint-deck')],
      starterIds: ['research-report'],
      missingToolsets: {},
      projectType: null,
      suggestedIds: [],
      establishedCodebase: false,
    });
});

it('opens a starter directly in the project quick launch, and See all opens the gallery', async () => {
  render(<MakeSomething projectId="garden" projects={projects} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /Research report/ }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('"initialCraftbookId":"research-report"'),
  );
  expect(screen.getByRole('status')).toHaveTextContent('"defaultProjectId":"garden"');
  expect(screen.getByRole('status')).toHaveTextContent('"quickLaunch":true');
  expect(screen.queryByRole('button', { name: /Slide deck/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'See all' }));
  expect(screen.getByRole('status')).toHaveTextContent('"quickLaunch":false');
});

it('honors an empty server starter set instead of reintroducing fallback ids', async () => {
  vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
    items: [item('research-report')],
    starterIds: [],
    missingToolsets: {},
    projectType: null,
    suggestedIds: [],
    establishedCodebase: false,
  });
  render(<MakeSomething projectId="garden" projects={projects} />);
  await waitFor(() => expect(api.listProjectCraftbooks).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: /Research report/ })).not.toBeInTheDocument();
});

it('offers retry after a failed catalog request', async () => {
  vi.mocked(api.listProjectCraftbooks).mockRejectedValueOnce(new Error('Offline'));
  render(<MakeSomething projectId="default" projects={projects} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('button', { name: /Research report/ })).toBeInTheDocument();
});

it('uses Default until a valid project has been visited, excluding the shared library', () => {
  const all = [
    ...projects,
    {
      id: 'library',
      name: 'Library',
      properties: { 'gezel.sharedLibrary': '1' },
    } as unknown as Project,
  ];
  expect(deriveLaunchProjectId(null, all)).toBe('default');
  expect(
    deriveLaunchProjectId(
      {
        recentTabs: [
          { kind: 'project', id: 'library', at: 3 },
          { kind: 'project', id: 'deleted', at: 2 },
          { kind: 'project', id: 'garden', at: 1 },
        ],
      } as never,
      all,
    ),
  ).toBe('garden');
});
