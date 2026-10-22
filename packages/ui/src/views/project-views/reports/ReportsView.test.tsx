import type { ProjectDetail, ProjectReportsResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { looksLikeFilePath } from '../../../components/ReportDocument.js';
import ReportsProjectView from './index.js';

vi.mock('../../../api.js', () => ({
  api: {
    listProjectReports: vi.fn(),
    generateProjectReport: vi.fn(),
    readProjectArtifact: vi.fn(),
  },
}));

const { api } = await import('../../../api.js');
const listProjectReports = vi.mocked(api.listProjectReports);
const generateProjectReport = vi.mocked(api.generateProjectReport);
const readProjectArtifact = vi.mocked(api.readProjectArtifact);

const NOW = Date.now();
const LIST: ProjectReportsResponse = {
  reports: [
    {
      path: 'reports/codebase-2026-10-21.md',
      title: 'Your codebase · 2026-10-21',
      kind: 'codebase',
      mtimeMs: NOW - 60_000,
      size: 400,
      actions: 2,
    },
    {
      path: 'reports/codebase-map.md',
      title: 'Demo: codebase map',
      kind: 'map',
      mtimeMs: NOW - 86_400_000,
      size: 900,
      actions: 0,
    },
  ],
  writable: ['codebase', 'map'],
  truncated: false,
};

const CONTENT: Record<string, string> = {
  'reports/codebase-2026-10-21.md':
    '# Your codebase · 2026-10-21\n\n## Hotspots\n\n- `src/parser.ts` · 30 commits this year\n- `not a path` here\n',
  'reports/codebase-map.md':
    '# Demo: codebase map\n\nA small demo.\n\n## Where things live\n\nThe [parser](src/parser.ts) reads input.\n',
};

const project = { id: 'p1', name: 'Demo', packages: [] } as unknown as ProjectDetail;

function renderReports(compact = false) {
  const onSelectPath = vi.fn();
  const utils = render(
    <ReportsProjectView
      projectId="p1"
      project={project}
      compact={compact}
      selectedPath={null}
      onSelectPath={onSelectPath}
      setInspectorExtras={vi.fn()}
    />,
  );
  return { ...utils, onSelectPath };
}

beforeEach(() => {
  listProjectReports.mockReset();
  generateProjectReport.mockReset();
  readProjectArtifact.mockReset();
  readProjectArtifact.mockImplementation(async (_id, path) => ({
    path,
    content: CONTENT[path] ?? '',
  }) as never);
});

describe('ReportsProjectView', () => {
  it('lists reports by kind and opens the newest in the reader', async () => {
    listProjectReports.mockResolvedValue(LIST);
    renderReports();
    const list = await screen.findByRole('navigation', { name: 'Reports' });
    expect(within(list).getByText('Codebase map')).toBeInTheDocument();
    expect(within(list).getByText('Codebase')).toBeInTheDocument();
    expect(within(list).getByText(/2 suggestions/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Hotspots' })).toBeInTheDocument();
    expect(readProjectArtifact).toHaveBeenCalledWith('p1', 'reports/codebase-2026-10-21.md');
  });

  it('opens a file a report names in the inspector', async () => {
    listProjectReports.mockResolvedValue(LIST);
    const { container, onSelectPath } = renderReports();
    await screen.findByRole('heading', { name: 'Hotspots' });
    await waitFor(() => expect(container.querySelector('.report-document-path')).not.toBeNull());
    const paths = [...container.querySelectorAll('.report-document-path')].map((c) => c.textContent);
    expect(paths).toEqual(['src/parser.ts']);
    fireEvent.click(container.querySelector('.report-document-path')!);
    expect(onSelectPath).toHaveBeenLastCalledWith('src/parser.ts', undefined);

    fireEvent.click(screen.getByRole('button', { name: /Demo: codebase map/ }));
    const link = await screen.findByRole('link', { name: 'parser' });
    fireEvent.click(link);
    expect(onSelectPath).toHaveBeenLastCalledWith('src/parser.ts', undefined);
  });

  it('writes a report now and selects it, or says there was nothing new', async () => {
    listProjectReports.mockResolvedValue(LIST);
    generateProjectReport.mockResolvedValueOnce({ path: 'reports/codebase-2026-10-21.md', wrote: true });
    renderReports();
    fireEvent.click(await screen.findByRole('button', { name: 'Write codebase report now' }));
    await waitFor(() => expect(generateProjectReport).toHaveBeenCalledWith('p1', 'codebase'));
    await waitFor(() => expect(listProjectReports).toHaveBeenCalledTimes(2));

    generateProjectReport.mockResolvedValueOnce({ path: null, wrote: false });
    fireEvent.click(screen.getByRole('button', { name: 'Write codebase report now' }));
    expect(await screen.findByText(/Nothing new to put in a codebase report yet/)).toBeInTheDocument();
  });

  it('invites a first report when there are none', async () => {
    listProjectReports.mockResolvedValue({ reports: [], writable: ['documents'], truncated: false });
    renderReports();
    expect(await screen.findByText(/No reports yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write documents report now' })).toBeInTheDocument();
  });
});

describe('looksLikeFilePath', () => {
  it('takes paths with an extension and nothing else', () => {
    expect(looksLikeFilePath('src/parser.ts')).toBe(true);
    expect(looksLikeFilePath('README.md')).toBe(true);
    expect(looksLikeFilePath('npm run test')).toBe(false);
    expect(looksLikeFilePath('https://example.com/a.js')).toBe(false);
    expect(looksLikeFilePath('src/')).toBe(false);
  });
});
