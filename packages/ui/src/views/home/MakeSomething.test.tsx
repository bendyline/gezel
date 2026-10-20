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
vi.mock('../projects/NewProjectDialog.js', () => ({
  NewProjectDialog: (props: {
    initialTypeId?: string;
    onCreated: (project: { id: string; name: string }) => void;
  }) => (
    <output>
      {JSON.stringify(props)}
      <button type="button" onClick={() => props.onCreated({ id: 'spanish', name: 'Spanish' })}>
        Create
      </button>
    </output>
  ),
}));
const { api } = await import('../../api.js');
const { MakeSomething } = await import('./MakeSomething.js');
const { peekPendingSettingsSection } = await import('../../settings-nav.js');
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

const projectType = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    sourceId: 'bundled',
    kind: 'project-type',
    manifest: {
      id,
      kind: 'project-type',
      name: id,
      description: 'Practice every day: drills, stories and a streak. It adapts.',
      tags: [],
      craftbooks: [],
      schedules: [],
    },
    ...extra,
  }) as unknown as CatalogItemSummary;

beforeEach(() => {
  vi.mocked(api.listCatalogItems)
    .mockReset()
    .mockResolvedValue({ items: [] } as never);
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

it('offers project types beneath the plans and opens one straight on its form', async () => {
  vi.mocked(api.listCatalogItems).mockImplementation(
    async (kind) =>
      ({
        items:
          kind === 'project-type'
            ? [
                projectType('language-trainer'),
                projectType('email'),
                projectType('phone-only', { unavailableReason: 'Needs the desktop.' }),
              ]
            : [],
      }) as never,
  );
  const opened: unknown[] = [];
  const onOpenTab = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener('gezel:open-tab', onOpenTab);
  try {
    render(<MakeSomething projectId="garden" projects={projects} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Start a project' })).toBeInTheDocument();
    const key = screen.getByRole('button', { name: /language-trainer/ });
    expect(key).toHaveTextContent('Practice every day');
    expect(key).not.toHaveTextContent('streak');
    expect(screen.queryByRole('button', { name: /^email/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /phone-only/ })).not.toBeInTheDocument();

    await user.click(key);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('"initialTypeId":"language-trainer"'),
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(opened).toContainEqual({ kind: 'project', id: 'spanish' });
  } finally {
    window.removeEventListener('gezel:open-tab', onOpenTab);
  }
});

it('opens the whole project type gallery from its own See all', async () => {
  vi.mocked(api.listCatalogItems).mockImplementation(
    async (kind) =>
      ({ items: kind === 'project-type' ? [projectType('language-trainer')] : [] }) as never,
  );
  render(<MakeSomething projectId="garden" projects={projects} />);
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: 'See all project types' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('"open":true'));
  expect(screen.getByRole('status')).not.toHaveTextContent('initialTypeId');
});

it('opens Settings on Integrations from the integration link', async () => {
  const navigations: unknown[] = [];
  const onNavigate = (event: Event) => navigations.push((event as CustomEvent).detail);
  window.addEventListener('gezel:navigate', onNavigate);
  try {
    render(<MakeSomething projectId="garden" projects={projects} />);
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Integrate Gezel into other apps…' }));
    expect(peekPendingSettingsSection()).toBe('connectedApps');
    expect(navigations).toContainEqual({ view: 'settings', section: 'connectedApps' });
  } finally {
    window.removeEventListener('gezel:navigate', onNavigate);
  }
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

it('labels a starter by what comes back and keeps other plans’ own opening clause', async () => {
  const withGates = (id: string, tags: string[], description: string, ...files: string[]) => {
    const book = item(id);
    Object.assign(book.manifest, {
      tags,
      description,
      steps: files.map((file, index) => ({ id: `s${index}`, name: 'Step', advanceWhen: { file } })),
    });
    return book;
  };
  vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
    items: [
      withGates('research-report', ['starter'], 'A long research brief', 'scope.md', 'report.md'),
      withGates(
        'tidy-spreadsheet',
        ['first-project'],
        'Clean up a messy sheet: trims stray spaces and removes duplicate rows. It never guesses.',
        'plan.md',
        'index.html',
      ),
    ],
    starterIds: ['research-report'],
    missingToolsets: {},
    projectType: null,
    suggestedIds: [],
    establishedCodebase: false,
  });
  render(<MakeSomething projectId="garden" projects={projects} />);
  const starter = await screen.findByRole('button', { name: /Research report/ });
  expect(starter).toHaveTextContent('A written report');
  const firstProject = screen.getByRole('button', { name: /tidy-spreadsheet/ });
  expect(firstProject).toHaveTextContent('Clean up a messy sheet');
  expect(firstProject).not.toHaveTextContent('stray spaces');
  expect(firstProject).not.toHaveTextContent('A website');
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
