import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandsPanel } from './CommandsPanel.js';

const apiMocks = vi.hoisted(() => ({
  getProjectIndex: vi.fn(),
  getProjectIndexStatus: vi.fn(),
  getProjectSkills: vi.fn(),
  listProjectCraftbooks: vi.fn(),
  getProjectImportsPending: vi.fn(),
  refreshProjectIndex: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMocks }));

describe('CommandsPanel', () => {
  it('lists detected commands before craftbooks and sorts scripts alphabetically', async () => {
    apiMocks.getProjectIndexStatus.mockResolvedValue({
      state: 'fresh',
      meta: { scannedAt: '2026-07-28T00:00:00.000Z' },
    });
    apiMocks.getProjectIndex.mockResolvedValue({
      meta: {
        version: 1,
        scannedAt: '2026-07-28T00:00:00.000Z',
        root: '/workspace',
        durationMs: 1,
        fileCount: 3,
        commandCount: 5,
      },
      commands: [
        {
          name: 'test',
          kind: 'npm-script',
          source: 'package.json',
          run: 'npm run test',
        },
        {
          name: 'build',
          kind: 'npm-script',
          source: 'package.json',
          run: 'npm run build',
        },
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
        {
          name: 'biome',
          kind: 'bin',
          source: 'node_modules/.bin/biome',
          run: 'biome',
        },
      ],
      shapes: {},
    });
    apiMocks.getProjectSkills.mockResolvedValue({ skills: [] });
    apiMocks.listProjectCraftbooks.mockResolvedValue({
      items: [
        {
          manifest: {
            id: 'review',
            name: 'Review',
            description: 'Review the project.',
          },
        },
      ],
      missingToolsets: {},
      suggestedIds: [],
      projectType: null,
    });
    apiMocks.getProjectImportsPending.mockResolvedValue({ items: [] });

    const { container } = render(<CommandsPanel projectId="project-1" />);

    await waitFor(() => {
      expect(container.querySelectorAll('.commands-panel-group-title')).toHaveLength(4);
    });
    expect(
      Array.from(container.querySelectorAll('.commands-panel-group-title'), (heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(['npm scripts', 'Scripts folder', 'Installed CLIs', 'Craftbooks']);

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
