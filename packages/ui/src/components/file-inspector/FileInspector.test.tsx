import type { BoekwachterIssue, FileInsightResponse, FileReviewResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('@bendyline/squisq-editor-react', () => ({
  useEditorContext: () => ({ monacoEditor: null }),
  EditorShell: (props: { fileName?: string }) => (
    <div data-testid={props.fileName ? 'editor-stub' : 'markdown-stub'} />
  ),
}));
vi.mock('@bendyline/squisq-editor-react/styles', () => ({}));

import { api } from '../../api.js';
import { FileInspector } from './FileInspector.js';

const ISSUE: BoekwachterIssue = {
  id: 'issue-1',
  ref: 'BW-12',
  path: 'src/a.ts',
  severity: 'major',
  category: 'bug',
  message: 'Off-by-one in the range clamp',
  line: 4,
  status: 'open',
  seen: false,
  stale: false,
} as BoekwachterIssue;

function reviewWith(issues: BoekwachterIssue[]): FileReviewResponse {
  return {
    path: 'src/a.ts',
    found: true,
    review: {
      notesMd: 'Solid.',
      issues: [],
      health: 7,
      healthReason: 'Well structured.',
      model: 'qwen3-4b',
      reviewedAt: '2026-08-11T09:00:00.000Z',
    },
    trackedIssues: issues,
  } as FileReviewResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.readProjectWorkspaceFile).mockImplementation(async (_id, path: string) => ({
    path,
    content: 'export const a = 1;\n',
  }));
  vi.mocked(api.toolScanFindings).mockResolvedValue({
    findings: [],
    counts: { total: 0, bySeverity: {}, byCategory: {}, bySource: {} },
    truncated: false,
    indexed: true,
  });
  vi.mocked(api.toolFileContext).mockRejectedValue(new Error('no context'));
  vi.mocked(api.getFileInsight).mockResolvedValue(null);
});

function insight(partial: Partial<FileInsightResponse> & { path: string }): FileInsightResponse {
  return {
    indexed: true,
    file: null,
    summary: null,
    folder: { path: '' },
    connections: {
      imports: [],
      importedBy: [],
      links: [],
      linkedFrom: [],
      duplicates: [],
      truncated: false,
    },
    findings: { count: 0, maxSeverity: null },
    ...partial,
  };
}

function renderInspector(path = 'src/a.ts') {
  return render(
    <FileInspector projectId="p1" path={path} onSelectPath={() => {}} onClose={() => {}} />,
  );
}

describe('FileInspector', () => {
  it('shows tracked Librarian issues and acts on them', async () => {
    vi.mocked(api.toolFileReview)
      .mockResolvedValueOnce(reviewWith([ISSUE]))
      .mockResolvedValue(reviewWith([{ ...ISSUE, status: 'resolved', seen: true }]));
    vi.mocked(api.updateBoekwachterIssue).mockResolvedValue({} as never);
    renderInspector();

    expect(await screen.findByText('BW-12')).toBeInTheDocument();
    expect(screen.getByText('Librarian’s review · 7/10')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));

    await waitFor(() =>
      expect(api.updateBoekwachterIssue).toHaveBeenCalledWith('p1', {
        ref: 'BW-12',
        status: 'resolved',
        seen: true,
      }),
    );
    // The change is announced, so this pane (and any other) refetches; a
    // resolved issue then waits behind "Show closed".
    await waitFor(() => expect(screen.queryByText('BW-12')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Show closed' }));
    expect(screen.getByText('BW-12')).toBeInTheDocument();
  });

  it('leads with the summary and folder purpose, then opens connections in the view', async () => {
    vi.mocked(api.toolFileReview).mockResolvedValue({ path: 'docs/notes.md', found: false });
    vi.mocked(api.getFileInsight).mockResolvedValue(
      insight({
        path: 'docs/notes.md',
        summary: { text: 'The watering rota for the allotment.', lead: 'The watering rota.' },
        folder: { path: 'docs', purpose: 'Plot notes and rotas.', purposePath: 'docs' },
        connections: {
          imports: [],
          importedBy: [],
          links: [{ path: 'docs/plots.md', names: [] }],
          linkedFrom: [],
          duplicates: ['backup/notes.md'],
          truncated: false,
        },
      }),
    );
    const onSelectPath = vi.fn();
    render(
      <FileInspector
        projectId="p1"
        path="docs/notes.md"
        onSelectPath={onSelectPath}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText('The watering rota for the allotment.')).toBeInTheDocument();
    expect(screen.getByText(/Plot notes and rotas\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Links to/ }));
    fireEvent.click(screen.getByRole('button', { name: 'docs/plots.md' }));
    expect(onSelectPath).toHaveBeenCalledWith('docs/plots.md');
    expect(screen.getByRole('button', { name: /Copies/ })).toBeInTheDocument();
  });

  it('shows a photo’s capture facts as chips', async () => {
    vi.mocked(api.toolFileReview).mockResolvedValue({ path: 'photos/beans.png', found: false });
    vi.mocked(api.getFileInsight).mockResolvedValue(
      insight({
        path: 'photos/beans.png',
        media: { takenAt: '2026-06-01T09:00:00Z', width: 800, height: 600, cameraModel: 'Pixel 9' },
      }),
    );
    renderInspector('photos/beans.png');
    expect(await screen.findByText('taken 2026-06-01')).toBeInTheDocument();
    expect(screen.getByText('800×600')).toBeInTheDocument();
    expect(screen.getByText('Pixel 9')).toBeInTheDocument();
  });

  it('previews a photo instead of calling it a binary file', async () => {
    vi.mocked(api.toolFileReview).mockResolvedValue({ path: 'photos/beans.png', found: false });
    vi.mocked(api.readProjectWorkspaceFile).mockResolvedValue({
      path: 'photos/beans.png',
      content: '\u0089PNG\r\n\u001a\n\u0000\u0000\u0000',
    });
    vi.mocked(api.fetchProjectThumbnail).mockResolvedValue(new Blob(['x']));
    renderInspector('photos/beans.png');

    await waitFor(() =>
      expect(api.fetchProjectThumbnail).toHaveBeenCalledWith(
        'p1',
        'photos/beans.png',
        640,
        expect.anything(),
      ),
    );
    expect(screen.queryByText('Binary file — no preview.')).toBeNull();
  });
});
