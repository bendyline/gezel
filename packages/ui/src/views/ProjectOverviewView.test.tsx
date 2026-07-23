import { render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByText('AI study in progress…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('digest-md')).toHaveTextContent('Week 27'));
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
