import type { CatalogItemSummary, GezelSummary, Project, Task } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';
import { primitivesMock } from '../../test-utils/primitivesMock.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../primitives/index.js', () => primitivesMock);
vi.mock('../../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
// The squisq JsonEditor doesn't load in jsdom — replace it with a button
// that emits one param change so we can drive values without Monaco.
vi.mock('@bendyline/squisq-editor-react', () => ({
  JsonEditor: ({ onChange }: { onChange?: (v: unknown) => void }) => (
    <button
      type="button"
      data-testid="json-editor"
      onClick={() => onChange?.({ intensity: 'high' })}
    >
      params
    </button>
  ),
}));
vi.mock('../../components/CraftbookToolsetSetup.js', () => ({
  CraftbookToolsetSetup: () => <div data-testid="toolset-setup">setup</div>,
}));

const { NewTaskDialog } = await import('./NewTaskDialog.js');
const { api } = await import('../../api.js');

const PROJECTS: Project[] = [{ id: 'pj-alpha', name: 'Alpha' } as Project];
const GEZELS: GezelSummary[] = [
  { id: 'gz-maya', name: 'Maya', role: 'Researcher' } as GezelSummary,
];

function bookItem(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
): CatalogItemSummary {
  return {
    sourceId: 'bundled',
    kind: 'craftbook-template',
    manifest: {
      schemaVersion: 1,
      kind: 'craftbook-template',
      id,
      name,
      description: `${name} description`,
      tags: ['gallery'],
      maintainer: { name: 'gezel' },
      version: '1.0.0',
      releasedAt: '2025-01-01T00:00:00Z',
      about: `${name} about`,
      steps: [
        { id: 'build', name: 'Build', suggestedRole: 'developer' },
        { id: 'review', name: 'Review', suggestedRole: 'reviewer' },
      ],
      entryStepId: 'build',
      availableVersions: ['1.0.0'],
      ...overrides,
    },
  } as unknown as CatalogItemSummary;
}

function renderDialog(props: Partial<Parameters<typeof NewTaskDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <NewTaskDialog
      open
      defaultProjectId="pj-alpha"
      projects={PROJECTS}
      gezels={GEZELS}
      projectLocked={false}
      onClose={onClose}
      onCreated={onCreated}
      {...props}
    />,
  );
  return { onClose, onCreated };
}

describe('NewTaskDialog', () => {
  beforeEach(() => {
    vi.mocked(api.listProjectCraftbooks).mockReset();
    vi.mocked(api.createTask).mockReset();
    vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
      items: [
        bookItem('code-review', 'Code Review', {
          basedOn: { name: 'Upstream review', url: 'https://example.com/upstream-review' },
        }),
        bookItem('blog-post', 'Blog Post'),
      ],
      missingToolsets: {},
      projectType: { id: 'web-app', label: 'Web App' },
      suggestedIds: ['code-review'],
    } as never);
  });

  it('leads with the recommended shelf for the project type plus the general card', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('Recommended for Web App')).toBeInTheDocument();
    });
    expect(screen.getByRole('radio', { name: 'General task' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Code Review' })).toBeInTheDocument();
    // The non-suggested book sits behind the "browse all" affordance.
    expect(screen.queryByRole('radio', { name: 'Blog Post' })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Browse all 2 craftbooks/ }));
    expect(screen.getByRole('radio', { name: 'Blog Post' })).toBeInTheDocument();
  });

  it('groups craftbooks into project-lifecycle shelves', async () => {
    vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
      items: [
        bookItem('branding-website', 'Branding Website', { role: 'project-starter' }),
        bookItem('code-review', 'Code Review', { role: 'maintenance-review' }),
        bookItem('research-report', 'Research Report', { role: 'general' }),
      ],
      missingToolsets: {},
      projectType: null,
      suggestedIds: [],
      establishedCodebase: false,
    });

    renderDialog();
    const user = userEvent.setup();
    const starters = await screen.findByRole('button', { name: /New project starters/ });
    expect(screen.getByRole('button', { name: /Maintenance & review/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /General work/ })).toBeInTheDocument();

    await user.click(starters);
    expect(screen.getByRole('radio', { name: 'Branding Website' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Code Review' })).not.toBeInTheDocument();
  });

  it('ranks recommended title matches first when searching', async () => {
    vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
      items: [
        bookItem('content-accuracy-review', 'Content Accuracy Review'),
        bookItem('pull-request-review', 'Pull Request Review', {
          tags: ['review', 'pull-request', 'recommended'],
        }),
        bookItem('code-review', 'Code Review', { tags: ['review', 'recommended'] }),
      ],
      missingToolsets: {},
      projectType: null,
      suggestedIds: [],
      establishedCodebase: true,
    });

    renderDialog();
    const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox', { name: 'Search craftbooks' }), 'review');

    expect(screen.getAllByRole('radio').map((item) => item.getAttribute('aria-label'))).toEqual([
      'Code Review',
      'Pull Request Review',
      'Content Accuracy Review',
    ]);
  });

  it('creates a general task as a ready-to-fire draft', async () => {
    vi.mocked(api.createTask).mockResolvedValue({
      ref: 'pj-alpha/1',
      projectId: 'pj-alpha',
      num: 1,
    } as Task);
    const { onCreated, onClose } = renderDialog();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'General task' })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const titleLabel = screen.getByText('Title');
    await user.type(
      titleLabel.parentElement?.querySelector('input') as HTMLInputElement,
      'Refactor',
    );
    const descLabel = screen.getByText(/^Description/);
    await user.type(
      descLabel.parentElement?.querySelector('textarea') as HTMLTextAreaElement,
      'This is a long enough description to satisfy the 40 char minimum length.',
    );
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => {
      expect(api.createTask).toHaveBeenCalledWith(
        'pj-alpha',
        expect.objectContaining({
          title: 'Refactor',
          status: 'draft',
          steps: [{ name: 'Main' }],
          assignee: { kind: 'gezel', gezelId: 'gz-maya' },
        }),
      );
    });
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects a general task whose description is under 40 characters', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'General task' })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const titleLabel = screen.getByText('Title');
    await user.type(titleLabel.parentElement?.querySelector('input') as HTMLInputElement, 'Tiny');
    const descLabel = screen.getByText(/^Description/);
    await user.type(
      descLabel.parentElement?.querySelector('textarea') as HTMLTextAreaElement,
      'too short',
    );
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => {
      expect(screen.getByText(/at least 40 characters/i)).toBeInTheDocument();
    });
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('selecting a craftbook previews its steps and creates and starts it', async () => {
    vi.mocked(api.createTask).mockResolvedValue({
      ref: 'pj-alpha/2',
      projectId: 'pj-alpha',
      num: 2,
    } as Task);
    const { onCreated } = renderDialog();
    await waitFor(() => {
      // Loading first renders the "all" shelf, then the recommendation
      // effect replaces it with the settled project-specific shelf. Waiting
      // for the heading avoids clicking a card from that transient render.
      expect(screen.getByText('Recommended for Web App')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Code Review' }));

    // The pane shows both steps with their role hints.
    expect(await screen.findByText(/^2 steps$/)).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('reviewer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upstream review' })).toHaveAttribute(
      'href',
      'https://example.com/upstream-review',
    );
    // No description/steps fields for a book — the recipe supplies them.
    expect(screen.queryByText(/^Description/)).not.toBeInTheDocument();

    expect(screen.getByText(/Starts immediately/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create & start' }));

    await waitFor(() => {
      expect(api.createTask).toHaveBeenCalledWith(
        'pj-alpha',
        expect.objectContaining({
          title: 'Code Review',
          craftbookId: 'code-review',
          craftbookSourceId: 'bundled',
          dispatchEntry: true,
          description: expect.stringContaining('Run the "Code Review" craftbook'),
        }),
      );
    });
    expect(vi.mocked(api.createTask).mock.calls[0]?.[1]).not.toHaveProperty('status');
    expect(onCreated).toHaveBeenCalled();
  });

  it('passes edited params through as craftbookParams and stamps a task note', async () => {
    vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
      items: [
        bookItem('code-review', 'Code Review', {
          paramSchema: {
            type: 'object',
            properties: { intensity: { type: 'string' } },
          },
        }),
      ],
      missingToolsets: {},
      projectType: null,
      suggestedIds: [],
    } as never);
    vi.mocked(api.createTask).mockResolvedValue({
      ref: 'pj-alpha/3',
      projectId: 'pj-alpha',
      num: 3,
      activeStepId: 'build',
    } as Task);

    renderDialog();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Code Review' })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Code Review' }));
    await user.click(screen.getByTestId('json-editor'));
    await user.click(screen.getByRole('button', { name: 'Create & start' }));

    await waitFor(() => {
      expect(api.createTask).toHaveBeenCalledWith(
        'pj-alpha',
        expect.objectContaining({
          craftbookId: 'code-review',
          craftbookParams: { intensity: 'high' },
          description: expect.stringContaining('with intensity=high'),
        }),
      );
    });
    await waitFor(() => {
      expect(api.appendTaskNote).toHaveBeenCalledWith(
        'pj-alpha',
        3,
        expect.objectContaining({ stepId: 'build' }),
      );
    });
  });

  it('defers the assignee to the entry step role rather than pinning a gezel', async () => {
    vi.mocked(api.createTask).mockResolvedValue({
      ref: 'pj-alpha/4',
      projectId: 'pj-alpha',
      num: 4,
    } as Task);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('Recommended for Web App')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Code Review' }));
    // The copy names the role instead of asking the user to choose.
    expect(await screen.findByText(/Step 1 goes to the developer/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create & start' }));

    await waitFor(() => {
      expect(api.createTask).toHaveBeenCalled();
    });
    // No assignee at all — the service stamps whoever "developer" resolves to.
    expect(vi.mocked(api.createTask).mock.calls[0]?.[1]).not.toHaveProperty('assignee');
  });

  it('sends an explicit pick that overrides the entry step role', async () => {
    vi.mocked(api.createTask).mockResolvedValue({
      ref: 'pj-alpha/5',
      projectId: 'pj-alpha',
      num: 5,
    } as Task);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('Recommended for Web App')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Code Review' }));
    // [0] is the project picker; [1] is "Assign to".
    await user.selectOptions(
      screen.getAllByTestId('mock-select')[1] as HTMLSelectElement,
      'gz-maya',
    );
    await user.click(screen.getByRole('button', { name: 'Create & start' }));

    await waitFor(() => {
      expect(api.createTask).toHaveBeenCalledWith(
        'pj-alpha',
        expect.objectContaining({ assignee: { kind: 'gezel', gezelId: 'gz-maya' } }),
      );
    });
  });

  it('falls back to the roster default for a craftbook whose entry step names no role', async () => {
    vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
      items: [
        bookItem('blog-post', 'Blog Post', {
          steps: [{ id: 'build', name: 'Build' }],
          entryStepId: 'build',
        }),
      ],
      missingToolsets: {},
      projectType: null,
      suggestedIds: [],
    } as never);
    vi.mocked(api.createTask).mockResolvedValue({
      ref: 'pj-alpha/6',
      projectId: 'pj-alpha',
      num: 6,
    } as Task);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Blog Post' })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Blog Post' }));
    await user.click(screen.getByRole('button', { name: 'Create & start' }));

    await waitFor(() => {
      expect(api.createTask).toHaveBeenCalledWith(
        'pj-alpha',
        expect.objectContaining({ assignee: { kind: 'gezel', gezelId: 'gz-maya' } }),
      );
    });
  });

  it('blocks creation while a craftbook still needs toolset setup', async () => {
    vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
      items: [bookItem('code-review', 'Code Review')],
      missingToolsets: { 'code-review': [{ toolsetId: 'github' }] },
      projectType: null,
      suggestedIds: [],
    } as never);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Code Review' })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Code Review' }));

    expect(screen.getByTestId('toolset-setup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create & start' })).toBeDisabled();
  });

  it('curates scheduling candidates and creates a recurring craftbook host', async () => {
    vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
      items: [
        bookItem('weekly-review', 'Weekly Review', {
          runModes: { scheduled: 'recommended' },
        }),
        bookItem('launch-check', 'Launch Check'),
      ],
      missingToolsets: {},
      projectType: null,
      suggestedIds: [],
    } as never);
    vi.mocked(api.createTask).mockResolvedValue({
      ref: 'pj-alpha/7',
      projectId: 'pj-alpha',
      num: 7,
      cron: { expression: '0 9 * * 1' },
    } as Task);

    renderDialog({ creationMode: 'scheduled' });
    expect(await screen.findByText('Scheduled craftbooks')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Weekly Review' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Launch Check' })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Weekly Review' }));
    const cronLabel = screen.getByText(/^Cron expression/);
    await user.type(
      cronLabel.parentElement?.querySelector('input') as HTMLInputElement,
      '0 9 * * 1',
    );
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => {
      expect(api.createTask).toHaveBeenCalledWith(
        'pj-alpha',
        expect.objectContaining({
          spawnsCraftbookId: 'weekly-review',
          spawnsCraftbookSourceId: 'bundled',
          cron: { expression: '0 9 * * 1', overlap: 'skip' },
          steps: [expect.objectContaining({ name: 'Wait for schedule' })],
        }),
      );
    });
    expect(vi.mocked(api.createTask).mock.calls[0]?.[1]).not.toHaveProperty('craftbookId');
  });

  it('creates active work gated to Night Shift', async () => {
    vi.mocked(api.listProjectCraftbooks).mockResolvedValue({
      items: [
        bookItem('deep-audit', 'Deep Audit', {
          runModes: { nightShift: 'recommended' },
        }),
        bookItem('quick-note', 'Quick Note'),
      ],
      missingToolsets: {},
      projectType: null,
      suggestedIds: [],
    } as never);
    vi.mocked(api.createTask).mockResolvedValue({
      ref: 'pj-alpha/8',
      projectId: 'pj-alpha',
      num: 8,
      nightShift: { enabled: true },
    } as Task);

    renderDialog({ creationMode: 'night-shift' });
    expect(await screen.findByText('Night Shift craftbooks')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Deep Audit' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Quick Note' })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Deep Audit' }));
    await user.click(screen.getByRole('button', { name: 'Queue for Night Shift' }));

    await waitFor(() => {
      expect(api.createTask).toHaveBeenCalledWith(
        'pj-alpha',
        expect.objectContaining({
          craftbookId: 'deep-audit',
          nightShift: { enabled: true },
          dispatchEntry: true,
        }),
      );
    });
    expect(vi.mocked(api.createTask).mock.calls[0]?.[1]).not.toHaveProperty('status');
  });
});
