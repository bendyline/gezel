import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const api = createMockApi({
  getFileSummary: vi
    .fn()
    .mockResolvedValue(
      '## Lease\n\nThe flat lease for **2026**, renewed in March.\n\nRent is due monthly.',
    ),
});
vi.mock('../api.js', () => ({ api }));

const { FileAboutLine, summaryLead } = await import('./FileAboutLine.js');

describe('FileAboutLine', () => {
  it("shows the first paragraph of the Boekwachter's summary", async () => {
    render(<FileAboutLine projectId="docs" path="Home/lease.pdf" />);
    expect((await screen.findByTestId('file-about')).textContent).toBe(
      'About this file · The flat lease for 2026, renewed in March.',
    );
    expect(api.getFileSummary).toHaveBeenCalledWith('docs', 'Home/lease.pdf');
  });

  it('renders nothing before the file has been read', async () => {
    api.getFileSummary!.mockResolvedValueOnce(null);
    const { container } = render(<FileAboutLine projectId="docs" path="new.pdf" />);
    await Promise.resolve();
    expect(container.textContent).toBe('');
  });

  it('keeps the line short', () => {
    expect(summaryLead('x'.repeat(400))).toHaveLength(278);
  });
});
