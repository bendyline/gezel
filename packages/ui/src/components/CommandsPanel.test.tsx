import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandsPanel } from './CommandsPanel.js';
import { osCommandGroups } from './os-commands.js';

const apiMocks = vi.hoisted(() => ({
  health: vi.fn(),
  getProjectIndex: vi.fn(),
  getProjectIndexStatus: vi.fn(),
  refreshProjectIndex: vi.fn(),
  getProjectSkills: vi.fn(),
  listProjectCraftbooks: vi.fn(),
  getProjectImportsPending: vi.fn(),
  // The skills + imports actions. Without these, `invokeSkill` and
  // `reviewImport` throw "is not a function" the moment a test clicks one.
  createTask: vi.fn(),
  approveProjectImport: vi.fn(),
  rejectProjectImport: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMocks }));

const INDEX = {
  commands: [
    { kind: 'npm-script', name: 'build', run: 'pnpm build', source: 'package.json' },
    { kind: 'bin', name: 'gh', run: 'gh', source: 'PATH' },
  ],
};

/**
 * Richer fixture for the combined-rail ordering test: two of each script kind
 * (deliberately out of alphabetical order on disk) plus one installed binary.
 */
const ORDERED_INDEX = {
  meta: {
    version: 1,
    scannedAt: '2026-07-28T00:00:00.000Z',
    root: '/workspace',
    durationMs: 1,
    fileCount: 3,
    commandCount: 5,
  },
  commands: [
    { name: 'test', kind: 'npm-script', source: 'package.json', run: 'npm run test' },
    { name: 'build', kind: 'npm-script', source: 'package.json', run: 'npm run build' },
    {
      name: 'stamp-docs.mjs',
      kind: 'workspace-script',
      source: 'scripts/stamp-docs.mjs',
      run: 'node scripts/stamp-docs.mjs',
    },
    {
      name: 'clean.mjs',
      kind: 'workspace-script',
      source: 'scripts/clean.mjs',
      run: 'node scripts/clean.mjs',
    },
    { name: 'biome', kind: 'bin', source: 'node_modules/.bin/biome', run: 'biome' },
  ],
  shapes: {},
};

beforeEach(() => {
  window.__GEZEL__ = { ...window.__GEZEL__, token: 't', platform: 'linux' };
  apiMocks.health.mockResolvedValue({ platform: 'linux' });
  apiMocks.getProjectIndex.mockResolvedValue(INDEX);
  apiMocks.getProjectIndexStatus.mockResolvedValue({ state: 'fresh', meta: { scannedAt: '1' } });
  apiMocks.refreshProjectIndex.mockResolvedValue(undefined);
  apiMocks.getProjectSkills.mockResolvedValue({ skills: [] });
  apiMocks.listProjectCraftbooks.mockResolvedValue({ items: [] });
  apiMocks.getProjectImportsPending.mockResolvedValue({ items: [] });
  apiMocks.createTask.mockResolvedValue({ ref: 'p1/1', projectId: 'p1', num: 1 });
  apiMocks.approveProjectImport.mockResolvedValue({ ok: true });
  apiMocks.rejectProjectImport.mockResolvedValue({ ok: true });
});

const SKILL = {
  name: 'summarize',
  source: '.claude/skills/summarize/SKILL.md',
  description: 'Summarize a document',
  body: '# Summarize\n\nDo the thing.',
};

const PENDING_IMPORT = {
  skillSource: '.claude/skills/old-script/SKILL.md',
  sourceHash: 'h1',
  craftbook: { id: 'old-script', name: 'Old script' },
  scripts: [{ name: 'old-script.mjs', source: 'export default () => {};' }],
  createdAt: '2026-08-01T00:00:00.000Z',
};

const CRAFTBOOK = {
  sourceId: 'gilde',
  manifest: {
    id: 'ship-it',
    name: 'Ship it',
    description: 'Ship the thing',
    paramSchema: {},
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('osCommandGroups', () => {
  it('teaches bash on posix and PowerShell on Windows', () => {
    const posix = osCommandGroups('linux').flatMap((g) => g.items.map((i) => i.run));
    const win = osCommandGroups('win32').flatMap((g) => g.items.map((i) => i.run));
    expect(posix).toContain('grep -r "search text" .');
    expect(posix).toContain('xdg-open .');
    expect(win).toContain('Get-ChildItem -Recurse -File | Select-String -Pattern "search text"');
    expect(win).toContain('explorer .');
    // grep/find/touch/man don't exist in PowerShell — a primer that lists them
    // teaches a normal user a command that errors.
    expect(win.some((r) => /^(grep|find|touch|man|which) /.test(r))).toBe(false);
  });

  it('never leaves a placeholder unquoted (< and > redirect in both shells)', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      for (const group of osCommandGroups(platform)) {
        for (const item of group.items) {
          expect(item.run).not.toMatch(/[<>]/);
          expect(item.description.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('CommandsPanel sections', () => {
  it('shows the primer and machine tools, not repo scripts, in "commands"', async () => {
    render(<CommandsPanel projectId="p1" section="commands" onStageCommand={() => {}} />);
    expect(await screen.findByText('Getting around')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Tools on this machine')).toBeTruthy());
    expect(screen.queryByText('npm scripts')).toBeNull();
  });

  it('shows only repo scripts in "scripts"', async () => {
    render(<CommandsPanel projectId="p1" section="scripts" onStageCommand={() => {}} />);
    expect(await screen.findByText('npm scripts')).toBeTruthy();
    expect(screen.queryByText('Getting around')).toBeNull();
    expect(screen.queryByText('Tools on this machine')).toBeNull();
  });

  it('skips the workspace index entirely in "tasks"', async () => {
    render(<CommandsPanel projectId="p1" section="tasks" onStageCommand={() => {}} />);
    await waitFor(() => expect(apiMocks.listProjectCraftbooks).toHaveBeenCalled());
    expect(apiMocks.getProjectIndexStatus).not.toHaveBeenCalled();
    expect(screen.queryByText('Getting around')).toBeNull();
  });

  it('does not retry a workspace scan when indexing is disabled', async () => {
    apiMocks.getProjectIndexStatus.mockResolvedValue({ state: 'disabled' });

    render(<CommandsPanel projectId="p1" section="scripts" onStageCommand={() => {}} />);

    expect(await screen.findByText('Workspace indexing is off for this project.')).toBeTruthy();
    expect(apiMocks.refreshProjectIndex).not.toHaveBeenCalled();
    expect(apiMocks.getProjectIndex).not.toHaveBeenCalled();
  });

  it('stages a primer line rather than running it', async () => {
    const onStage = vi.fn();
    render(<CommandsPanel projectId="p1" section="commands" onStageCommand={onStage} />);
    await userEvent.click(await screen.findByTitle('Stage: pwd'));
    expect(onStage).toHaveBeenCalledWith('pwd');
  });

  it('still lists craftbooks alongside skills and imports in "tasks"', async () => {
    // The regression net for the terminal toolbar's third gallery, which is
    // the only remaining craftbook launcher outside the "+" button.
    apiMocks.listProjectCraftbooks.mockResolvedValue({ items: [CRAFTBOOK] });
    apiMocks.getProjectSkills.mockResolvedValue({ skills: [SKILL] });
    apiMocks.getProjectImportsPending.mockResolvedValue({
      items: [PENDING_IMPORT],
    });

    render(<CommandsPanel projectId="p1" section="tasks" onStageCommand={() => {}} />);

    expect(await screen.findByText('Craftbooks')).toBeTruthy();
    expect(screen.getByText('Skills (workspace)')).toBeTruthy();
    expect(screen.getByText('Imports to review (1)')).toBeTruthy();
  });
});

describe('CommandsPanel "skills" section', () => {
  it('shows only workspace skills and pending imports, and touches no other source', async () => {
    apiMocks.getProjectSkills.mockResolvedValue({ skills: [SKILL] });
    apiMocks.getProjectImportsPending.mockResolvedValue({
      items: [PENDING_IMPORT],
    });
    apiMocks.listProjectCraftbooks.mockResolvedValue({ items: [CRAFTBOOK] });

    render(<CommandsPanel projectId="p1" section="skills" />);

    expect(await screen.findByText('Skills (workspace)')).toBeTruthy();
    expect(screen.getByText('Imports to review (1)')).toBeTruthy();

    expect(screen.queryByText('Craftbooks')).toBeNull();
    expect(screen.queryByText('Getting around')).toBeNull();
    expect(screen.queryByText('Tools on this machine')).toBeNull();
    expect(screen.queryByText('npm scripts')).toBeNull();

    // The no-network guarantee: neither the craftbook list nor the workspace
    // index is fetched for a rail that renders neither.
    expect(apiMocks.listProjectCraftbooks).not.toHaveBeenCalled();
    expect(apiMocks.getProjectIndexStatus).not.toHaveBeenCalled();
  });

  it('invokes a workspace skill as a task with no staging callback wired', async () => {
    // Rendered with no `onStageCommand` at all — this is what makes it safe
    // for the chat rail to stop passing one.
    apiMocks.getProjectSkills.mockResolvedValue({ skills: [SKILL] });
    render(<CommandsPanel projectId="p1" section="skills" />);

    await userEvent.click(await screen.findByText('summarize'));

    await waitFor(() => expect(apiMocks.createTask).toHaveBeenCalled());
    const [projectId, body] = apiMocks.createTask.mock.calls[0] as [
      string,
      { assignee: { kind: string }; steps: Array<{ prompt: string }> },
    ];
    expect(projectId).toBe('p1');
    expect(body.assignee).toEqual({ kind: 'user' });
    expect(body.steps[0]?.prompt).toBe(SKILL.body);
  });

  it('approves a pending import', async () => {
    apiMocks.getProjectImportsPending.mockResolvedValue({
      items: [PENDING_IMPORT],
    });
    render(<CommandsPanel projectId="p1" section="skills" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(apiMocks.approveProjectImport).toHaveBeenCalledWith('p1', PENDING_IMPORT.skillSource),
    );
  });

  it('shows a skills-specific empty state', async () => {
    render(<CommandsPanel projectId="p1" section="skills" />);
    expect(await screen.findByText(/No workspace skills here yet/)).toBeTruthy();
  });
});

describe('CommandsPanel combined rail', () => {
  /**
   * The `all` rail stacks four sources. Order is the assertion that matters:
   * what this repo can actually run comes first, then the craftbooks a gezel
   * can pick up, and the fixed OS primer sits last — it leads its own tab,
   * where it IS the answer, but must not push real work down here.
   */
  it('lists detected commands, then craftbooks, then the primer', async () => {
    apiMocks.getProjectIndex.mockResolvedValue(ORDERED_INDEX);
    apiMocks.listProjectCraftbooks.mockResolvedValue({
      items: [{ manifest: { id: 'review', name: 'Review', description: 'Review the project.' } }],
      missingToolsets: {},
      suggestedIds: [],
      projectType: null,
    });

    const { container } = render(<CommandsPanel projectId="project-1" />);

    await waitFor(() => expect(screen.getByText('Craftbooks')).toBeTruthy());

    const titles = Array.from(container.querySelectorAll('.commands-panel-group-title'), (h) =>
      h.textContent?.trim(),
    );
    const primerTitles = osCommandGroups('linux').map((g) => g.title);

    expect(titles.slice(0, 4)).toEqual([
      'npm scripts',
      'Scripts folder',
      'Tools on this machine',
      'Craftbooks',
    ]);
    expect(titles.slice(4)).toEqual(primerTitles);
  });

  it('sorts scripts alphabetically regardless of on-disk order', async () => {
    apiMocks.getProjectIndex.mockResolvedValue(ORDERED_INDEX);

    const { container } = render(<CommandsPanel projectId="project-1" section="scripts" />);

    await waitFor(() => expect(screen.getByText('Scripts folder')).toBeTruthy());

    const groups = Array.from(container.querySelectorAll('.commands-panel-group'));
    const itemNames = (title: string) => {
      const group = groups.find(
        (candidate) =>
          candidate.querySelector('.commands-panel-group-title')?.textContent?.trim() === title,
      );
      return Array.from(group?.querySelectorAll('.commands-panel-item-name') ?? [], (item) =>
        item.textContent?.trim(),
      );
    };

    expect(itemNames('npm scripts')).toEqual(['build', 'test']);
    expect(itemNames('Scripts folder')).toEqual(['clean.mjs', 'stamp-docs.mjs']);
  });
});
