import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';
import { primitivesMock } from '../../test-utils/primitivesMock.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../primitives/index.js', () => primitivesMock);
vi.mock('../MarkdownField.js', () => ({
  MarkdownField: ({ value }: { value: string }) => <pre data-testid="report-md">{value}</pre>,
}));

const { CodeReviewView } = await import('./CodeReviewView.js');
const { api } = await import('../../api.js');

const RUNNING = {
  id: 'commit-20260729-100000-ab12',
  kind: 'commit' as const,
  status: 'running' as const,
  createdAt: new Date().toISOString(),
  taskRef: 'p1/3',
  gezelId: 'rex',
  branch: 'main',
  headSha: 'abc',
  filesChanged: 4,
  filesTruncated: false,
  diffTruncated: false,
  manifestPath: 'reviews/commit-20260729-100000-ab12/manifest.json',
  diffPath: 'reviews/commit-20260729-100000-ab12/changes.diff',
  reportPath: 'reviews/commit-20260729-100000-ab12/report.md',
  assigneeName: 'Rex',
  stepsTotal: 2,
  stepsComplete: 0,
  activeStepName: 'Review and write the report',
};

const COMPLETE = {
  ...RUNNING,
  id: 'pr-20260728-090000-cd34',
  kind: 'pr' as const,
  status: 'complete' as const,
  outcome: 'complete' as const,
  settledAt: new Date().toISOString(),
  branch: 'feature/x',
  reportPath: 'reviews/pr-20260728-090000-cd34/report.md',
};

function renderView(overrides: Partial<Parameters<typeof CodeReviewView>[0]> = {}) {
  const props = {
    projectId: 'p1',
    reviews: [],
    busy: '' as const,
    changesCount: 3,
    branch: 'feature/x',
    defaultBranch: 'main',
    onStart: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<CodeReviewView {...props} />);
  return props;
}

describe('CodeReviewView', () => {
  beforeEach(() => {
    vi.mocked(api.readProjectArtifact).mockResolvedValue({
      path: COMPLETE.reportPath,
      content: '# Code Review — tidy change\n\n## Summary\nLooks good.\n',
    } as never);
  });

  it('kickoff cards start the right kind', async () => {
    const user = userEvent.setup();
    const props = renderView();
    await user.click(screen.getByRole('button', { name: /Review my changes/ }));
    expect(props.onStart).toHaveBeenCalledWith('commit');
    await user.click(screen.getByRole('button', { name: /Review this branch/ }));
    expect(props.onStart).toHaveBeenCalledWith('pr');
    expect(screen.getByText(/against main/)).toBeTruthy();
  });

  it('disables the commit kickoff when there is nothing to review', () => {
    renderView({ changesCount: 0 });
    const button = screen.getByRole('button', { name: /Review my changes/ });
    expect(button).toHaveProperty('disabled', true);
  });

  it('shows the running card and routes cancel through the confirm dialog', async () => {
    const user = userEvent.setup();
    const props = renderView({ reviews: [RUNNING] });
    expect(screen.getByText(/Rex is looking over the changes/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Stop review/ }));
    await user.click(screen.getByRole('button', { name: 'Stop review' }));
    expect(props.onCancel).toHaveBeenCalledWith(RUNNING.id);
  });

  it('renders the newest finished review report inline', async () => {
    renderView({ reviews: [COMPLETE] });
    await waitFor(() => {
      expect(vi.mocked(api.readProjectArtifact)).toHaveBeenCalledWith('p1', COMPLETE.reportPath);
    });
    expect((await screen.findByTestId('report-md')).textContent).toContain('tidy change');
    expect(screen.getByRole('button', { name: /Open in artifacts/ })).toBeTruthy();
  });

  it('falls back to the missing-report copy when the artifact is gone', async () => {
    vi.mocked(api.readProjectArtifact).mockRejectedValue(new Error('404'));
    renderView({ reviews: [COMPLETE] });
    expect(await screen.findByText(/no report was written/)).toBeTruthy();
  });

  it('shows the empty-history copy when nothing has run', () => {
    renderView();
    expect(screen.getByText(/No reviews yet/)).toBeTruthy();
  });
});
