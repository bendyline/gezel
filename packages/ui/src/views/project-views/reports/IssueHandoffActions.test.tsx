import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueHandoffActions } from './IssueHandoffActions.js';

vi.mock('../../../api.js', () => ({
  api: {
    readProjectArtifact: vi.fn(),
    issueTriage: { importVerdicts: vi.fn() },
  },
}));

const { api } = await import('../../../api.js');
const readArtifact = vi.mocked(api.readProjectArtifact);
const importVerdicts = vi.mocked(api.issueTriage.importVerdicts);

beforeEach(() => {
  readArtifact.mockReset();
  importVerdicts.mockReset();
});

function renderActions() {
  const onImported = vi.fn();
  render(<IssueHandoffActions projectId="p1" path="reports/issue-handoff.md" onImported={onImported} />);
  return onImported;
}

describe('the handoff report keys', () => {
  it('copies the document for an app without Gezel tools', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    readArtifact.mockResolvedValue({ content: '# Issues for review' } as never);
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Copied/);
    expect(writeText).toHaveBeenCalledWith('# Issues for review');
  });

  it('imports the answers from a file and says what landed', async () => {
    importVerdicts.mockResolvedValue({
      results: [
        { ref: 'BW-1', outcome: 'applied', message: 'BW-1 is now dismissed.' },
        { ref: 'BW-2', outcome: 'refused', message: 'BW-2 is being worked on in task p1/4.' },
      ],
      applied: 1,
      refused: 1,
      skipped: ['BW-3'],
    });
    const onImported = renderActions();
    const file = new File(['Verdict: fixed'], 'issue-handoff.md', { type: 'text/markdown' });
    fireEvent.change(screen.getByLabelText('Answered handoff document'), {
      target: { files: [file] },
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      '1 answer imported, 1 not applied, 1 left empty. BW-2 is being worked on in task p1/4.',
    );
    expect(importVerdicts).toHaveBeenCalledWith('p1', { markdown: 'Verdict: fixed' });
    expect(onImported).toHaveBeenCalled();
  });
});
