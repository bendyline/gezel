import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportDocument } from './ReportDocument.js';

vi.mock('../api.js', () => ({
  api: { readProjectArtifact: vi.fn() },
}));

const { api } = await import('../api.js');
const readArtifact = vi.mocked(api.readProjectArtifact);

// Shaped like the handoff document: squisq makes the first paragraph a plain subtitle.
const REPORT = [
  '# Issues for review',
  '',
  'Flagged overnight.',
  '',
  '## src/save.ts',
  '',
  '### BW-4 · major · bug',
  '',
  '[`/repo/src/save.ts:12`](gezel-nav:src%2Fsave.ts#L12)',
].join('\n');

describe('a report read in place', () => {
  it('opens a file link at its line instead of following the scheme', async () => {
    readArtifact.mockResolvedValue({ content: REPORT } as never);
    const onOpenPath = vi.fn();
    const { container } = render(
      <ReportDocument projectId="p1" path="reports/issue-handoff.md" onOpenPath={onOpenPath} />,
    );
    const link = await waitFor(() => {
      const anchor = container.querySelector('a[href^="gezel-nav:"]');
      expect(anchor).not.toBeNull();
      return anchor!;
    });
    fireEvent.click(link);
    expect(onOpenPath).toHaveBeenCalledWith('src/save.ts', 12);
  });

  it('leaves the link inert where nothing would catch the click', async () => {
    readArtifact.mockResolvedValue({ content: REPORT } as never);
    const { container, findByText } = render(
      <ReportDocument projectId="p1" path="reports/issue-handoff.md" />,
    );
    await findByText('/repo/src/save.ts:12');
    expect(container.querySelector('a[href^="gezel-nav:"]')).toBeNull();
  });
});
