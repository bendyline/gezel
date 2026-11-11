import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({
  api: createMockApi({
    toolMapRepo: vi.fn().mockResolvedValue({
      root: '/w',
      languages: [{ lang: 'typescript', fileCount: 12 }],
      areas: [
        { path: 'src', fileCount: 12, purpose: 'Game engine and state machine.' },
        { path: 'assets', fileCount: 30 },
      ],
      entryPoints: ['src/main.ts'],
      keyFiles: ['package.json'],
      fileCount: 42,
      indexed: true,
      architecture: 'A small shop simulator with a UI and an engine.',
    }),
    getProjectIndexStatus: vi.fn().mockResolvedValue({ state: 'fresh', aiScanPending: true }),
    listHistory: vi.fn().mockResolvedValue({
      entries: [
        {
          entryType: 'event',
          id: 'e1',
          at: '2026-07-04T10:00:00Z',
          kind: 'project.updated',
          summary: 'Tweaked the mission',
        },
      ],
    }),
    listProjectArtifacts: vi.fn().mockResolvedValue({
      files: [
        { name: 'digest-2026-W27.md', path: 'reports/digest-2026-W27.md', isDirectory: false },
      ],
    }),
    readProjectArtifact: vi
      .fn()
      .mockResolvedValue({ path: 'reports/digest-2026-W27.md', content: '# Week 27\nBusy.' }),
  }),
}));
// The digest preview wraps the Squisq editor — far too heavy for jsdom.
vi.mock('../components/MarkdownField.js', () => ({
  MarkdownField: ({ value }: { value: string }) => <pre data-testid="digest-md">{value}</pre>,
}));

import { ProjectOverviewView } from './ProjectOverviewView.js';

const project = {
  id: 'p1',
  name: 'Winkel',
  detectedProjectType: { id: 'browser-game', score: 0.7, scannedAt: '2026-07-01T00:00:00Z' },
} as never;

describe('ProjectOverviewView', () => {
  it('renders the index-derived gestalt: architecture, areas, shape, activity, digest', async () => {
    render(<ProjectOverviewView projectId="p1" project={project} />);

    await waitFor(() =>
      expect(
        screen.getByText('A small shop simulator with a UI and an engine.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Game engine and state machine.')).toBeInTheDocument();
    // Areas without a deep-pass purpose stay off the list.
    expect(screen.queryByText('assets/')).not.toBeInTheDocument();
    expect(screen.getByText('typescript · 12')).toBeInTheDocument();
    expect(screen.getByText('src/main.ts')).toBeInTheDocument();
    expect(screen.getByText(/Tweaked the mission/)).toBeInTheDocument();
    // Unified index-status vocabulary — same label the status bar's chip uses.
    expect(screen.getByText('AI index in progress')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('digest-md')).toHaveTextContent('Week 27'));
  });

  it('asks for what happened to the work, and for everything in debug mode', async () => {
    const { api } = await import('../api.js');
    vi.mocked(api.listHistory).mockClear();
    render(<ProjectOverviewView projectId="p1" project={project} />);
    await waitFor(() =>
      expect(api.listHistory).toHaveBeenCalledWith({
        projectId: 'p1',
        limit: 8,
        audience: 'person',
      }),
    );
    vi.mocked(api.listHistory).mockClear();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('gezel:config-updated', { detail: { debugMode: true } }),
      );
    });
    await waitFor(() =>
      expect(api.listHistory).toHaveBeenCalledWith({ projectId: 'p1', limit: 8 }),
    );
    expect(api.toolMapRepo).toHaveBeenCalledTimes(1);
  });

  it('opening the digest dispatches the artifacts deep-link event', async () => {
    const events: unknown[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('gezel:open-file', listener);
    render(<ProjectOverviewView projectId="p1" project={project} />);
    await waitFor(() => screen.getByText('Open in artifacts'));
    screen.getByText('Open in artifacts').click();
    expect(events).toEqual([
      { projectId: 'p1', path: 'reports/digest-2026-W27.md', source: 'artifacts' },
    ]);
    window.removeEventListener('gezel:open-file', listener);
  });
});

describe('ProjectOverviewView data tables', () => {
  const project = { id: 'p1', name: 'Shop' } as never;

  it('lists spreadsheets and data files as tables, naming their source', async () => {
    const { api } = await import('../api.js');
    vi.mocked(api.toolListTables).mockResolvedValue({
      tables: [
        {
          table: 'q3-revenue',
          rows: 1204,
          columns: 4,
          partitions: 1,
          origin: 'workspace',
          source: 'data/plan.xlsx',
          schemaInferred: true,
        },
        {
          table: 'requests',
          rows: 4312889,
          columns: 8,
          partitions: 30,
          origin: 'connector',
          source: 'Web traffic',
          schemaInferred: false,
        },
      ],
    } as never);

    render(<ProjectOverviewView projectId="p1" project={project} />);

    expect(await screen.findByText('q3-revenue')).toBeTruthy();
    // "Which spreadsheet is this?" is the question a workspace table has to
    // answer, so the file path is on the line.
    expect(screen.getByText(/from data\/plan\.xlsx/)).toBeTruthy();
    expect(screen.getByText(/schema inferred/)).toBeTruthy();
    // Connector tables sit in the same list — one place to look.
    expect(screen.getByText('requests')).toBeTruthy();
    expect(screen.getByText(/4,312,889 rows/)).toBeTruthy();
  });

  it('shows no section at all for a project with no tables', async () => {
    const { api } = await import('../api.js');
    vi.mocked(api.toolListTables).mockResolvedValue({ tables: [] } as never);
    render(<ProjectOverviewView projectId="p1" project={project} />);
    await waitFor(() => expect(screen.queryByText('Data tables')).toBeNull());
  });
});

describe('ProjectOverviewView before the first scan', () => {
  const notScanned = /hasn't scanned this workspace yet/;

  it('promises a map and architecture summary only to a codebase', async () => {
    const { api } = await import('../api.js');
    vi.mocked(api.toolMapRepo).mockResolvedValue({
      root: '/w',
      languages: [],
      areas: [],
      entryPoints: [],
      keyFiles: [],
      fileCount: 0,
      indexed: false,
    } as never);
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({ state: 'never' } as never);
    const invoices = {
      id: 'office',
      name: 'Bakery Office',
      projectType: {
        id: 'freelance-office',
        version: '1.1.0',
        source: 'bundled',
        appliedAt: '2026-11-09T00:00:00Z',
        category: 'money',
      },
    } as never;
    const { unmount } = render(<ProjectOverviewView projectId="office" project={invoices} />);
    await waitFor(() => expect(api.toolMapRepo).toHaveBeenCalled());
    expect(screen.queryByText(notScanned)).toBeNull();
    unmount();

    const game = {
      id: 'p1',
      name: 'Winkel',
      detectedProjectType: { id: 'browser-game', score: 0.7, scannedAt: '2026-07-01T00:00:00Z' },
    } as never;
    render(<ProjectOverviewView projectId="p1" project={game} />);
    expect(await screen.findByText(notScanned)).toBeInTheDocument();
  });

  it('words recent activity as plain sentences, without ids or versions', async () => {
    const { api } = await import('../api.js');
    vi.mocked(api.listHistory).mockResolvedValue({
      entries: [
        {
          entryType: 'event',
          id: 'e3',
          at: '2026-11-09T21:00:00Z',
          kind: 'task.status.changed',
          projectId: 'office',
          summary: 'Task office/1 → complete',
          details: { ref: 'office/1', status: 'complete', previous: 'active' },
        },
        {
          entryType: 'event',
          id: 'e2',
          at: '2026-11-09T20:59:00Z',
          kind: 'task.created',
          projectId: 'office',
          summary: 'Created task office/1 — "First draft"',
          details: { ref: 'office/1', title: 'First draft' },
        },
        {
          entryType: 'event',
          id: 'e1',
          at: '2026-11-09T20:58:00Z',
          kind: 'project.updated',
          projectId: 'office',
          summary: 'Applied project type freelance-office@1.1.0',
          details: { projectType: 'freelance-office', version: '1.1.0' },
        },
      ],
    } as never);
    render(
      <ProjectOverviewView projectId="office" project={{ id: 'office', name: 'O' } as never} />,
    );
    const activity = await screen.findByTestId('overview-activity');
    expect(activity).toHaveTextContent('Finished "First draft"');
    expect(activity).toHaveTextContent('New task: First draft');
    expect(activity).toHaveTextContent('Set up as Freelance Office');
    expect(activity).not.toHaveTextContent('office/1');
    expect(activity).not.toHaveTextContent('1.1.0');
  });
});
