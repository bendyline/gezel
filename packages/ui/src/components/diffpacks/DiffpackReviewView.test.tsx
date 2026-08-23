import type { Diffpack } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';
import { primitivesMock } from '../../test-utils/primitivesMock.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../primitives/index.js', () => primitivesMock);
vi.mock('../MarkdownField.js', () => ({
  MarkdownField: ({ value }: { value: string }) => <pre data-testid="notes-md">{value}</pre>,
}));
vi.mock('../github/GitDiffView.js', () => ({
  GitDiffView: ({ diff }: { diff?: string }) => <pre data-testid="diff">{diff ?? ''}</pre>,
}));

const { DiffpackReviewView } = await import('./DiffpackReviewView.js');
const { api } = await import('../../api.js');

const DIFF = 'Index: src/a.ts\n--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';

function pack(over: Partial<Diffpack> = {}): Diffpack {
  return {
    packId: '1',
    projectId: 'p1',
    title: 'Guard the null parse',
    summary: 'The parser dropped the trailing comma.',
    status: 'ready',
    origin: { kind: 'boekwachter-issue', issueRefs: ['BW-8'] },
    taskRef: 'p1/1',
    gezelName: 'Rex',
    files: [
      {
        path: 'src/a.ts',
        diffArtifact: 'diffpacks/1/files/01-a.ts.diff',
        baseHash: 'h',
        additions: 1,
        deletions: 1,
        change: 'modify',
      },
    ],
    notesPath: 'diffpacks/1/notes.md',
    manifestPath: 'diffpacks/1/manifest.json',
    createdAt: '2026-08-22T02:00:00.000Z',
    sealedAt: '2026-08-22T02:30:00.000Z',
    drifted: [],
    overlaps: [],
    additions: 1,
    deletions: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listDiffpacks).mockResolvedValue({ diffpacks: [pack()] });
  vi.mocked(api.getDiffpack).mockResolvedValue({
    diffpack: pack(),
    notes: '# Fix\n\nThe parser dropped the trailing comma.',
  });
  vi.mocked(api.readProjectArtifact).mockResolvedValue({
    path: 'diffpacks/1/files/01-a.ts.diff',
    content: DIFF,
  } as never);
});

describe('DiffpackReviewView', () => {
  it('shows the proposal, its notes, and the diff for each file', async () => {
    render(<DiffpackReviewView projectId="p1" />);

    expect(
      await screen.findByRole('heading', { name: 'Guard the null parse' }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('notes-md')).toHaveTextContent('trailing comma');
    await waitFor(() => expect(screen.getByTestId('diff')).toHaveTextContent('+b'));
    expect(screen.getByTitle('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText(/BW-8/)).toBeInTheDocument();
  });

  it('tells the user nothing is waiting when there are no proposals', async () => {
    vi.mocked(api.listDiffpacks).mockResolvedValue({ diffpacks: [] });
    render(<DiffpackReviewView projectId="p1" />);
    expect(await screen.findByText(/No change proposals yet/)).toBeInTheDocument();
  });

  it('applies the whole proposal', async () => {
    const user = userEvent.setup();
    vi.mocked(api.applyDiffpack).mockResolvedValue({
      ok: true,
      diffpack: pack({ status: 'applied' }),
      results: [{ path: 'src/a.ts', ok: true }],
    });
    render(<DiffpackReviewView projectId="p1" />);

    await user.click(await screen.findByRole('button', { name: 'Apply all' }));
    expect(api.applyDiffpack).toHaveBeenCalledWith('p1', '1', {});
    expect(await screen.findByText(/Applied 1 file/)).toBeInTheDocument();
  });

  it('applies a single file when asked', async () => {
    const user = userEvent.setup();
    vi.mocked(api.applyDiffpack).mockResolvedValue({
      ok: true,
      diffpack: pack({ status: 'partially-applied' }),
      results: [{ path: 'src/a.ts', ok: true }],
    });
    render(<DiffpackReviewView projectId="p1" />);

    await user.click(await screen.findByRole('button', { name: 'Apply this file' }));
    expect(api.applyDiffpack).toHaveBeenCalledWith('p1', '1', { paths: ['src/a.ts'] });
  });

  it('names the files that moved before applying over drift', async () => {
    const user = userEvent.setup();
    vi.mocked(api.applyDiffpack).mockRejectedValueOnce(
      new Error('409 {"code":"drifted","paths":["src/a.ts"]}'),
    );
    render(<DiffpackReviewView projectId="p1" />);

    await user.click(await screen.findByRole('button', { name: 'Apply all' }));
    expect(await screen.findByText(/changed since the proposal was written/i)).toBeInTheDocument();
    // The dialog names the file rather than saying "some files changed".
    expect(screen.getAllByText('src/a.ts').length).toBeGreaterThan(1);

    vi.mocked(api.applyDiffpack).mockResolvedValue({
      ok: true,
      diffpack: pack({ status: 'applied' }),
      results: [{ path: 'src/a.ts', ok: true }],
    });
    await user.click(screen.getByRole('button', { name: 'Apply anyway' }));
    expect(api.applyDiffpack).toHaveBeenLastCalledWith('p1', '1', { allowDrifted: true });
  });

  it('warns when another proposal targets the same file', async () => {
    vi.mocked(api.listDiffpacks).mockResolvedValue({
      diffpacks: [pack({ overlaps: [{ path: 'src/a.ts', packIds: ['2'] }] })],
    });
    render(<DiffpackReviewView projectId="p1" />);
    expect(await screen.findByText(/Another proposal touches/)).toBeInTheDocument();
    expect(screen.getByText(/Overlaps DP-2/)).toBeInTheDocument();
  });

  it('marks a proposal whose target already moved', async () => {
    vi.mocked(api.listDiffpacks).mockResolvedValue({
      diffpacks: [pack({ drifted: ['src/a.ts'] })],
    });
    render(<DiffpackReviewView projectId="p1" />);
    expect(await screen.findByText(/may no longer fit/)).toBeInTheDocument();
    expect(screen.getByText('Out of date')).toBeInTheDocument();
  });

  it('will not apply a proposal that is still being drafted', async () => {
    vi.mocked(api.listDiffpacks).mockResolvedValue({
      diffpacks: [pack({ status: 'drafting', files: [] })],
    });
    render(<DiffpackReviewView projectId="p1" />);
    expect(await screen.findByRole('button', { name: 'Apply all' })).toBeDisabled();
  });

  it('dismisses a proposal', async () => {
    const user = userEvent.setup();
    vi.mocked(api.dismissDiffpack).mockResolvedValue({
      ok: true,
      diffpack: pack({ status: 'dismissed' }),
    });
    render(<DiffpackReviewView projectId="p1" />);

    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(api.dismissDiffpack).toHaveBeenCalledWith('p1', '1');
  });

  it('names the action tray after the proposal it acts on', async () => {
    render(<DiffpackReviewView projectId="p1" />);
    expect(await screen.findByRole('toolbar', { name: 'Actions for DP-1' })).toBeInTheDocument();
  });
});
