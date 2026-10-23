import type { BoekwachterIssue } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackedIssueItem, issueStatusLabel, sendIssuePatch } from './tracked-issues.js';

vi.mock('../../api.js', () => ({
  api: {
    issueTriage: { applyVerdicts: vi.fn() },
    updateBoekwachterIssue: vi.fn(),
  },
}));

const { api } = await import('../../api.js');
const applyVerdicts = vi.mocked(api.issueTriage.applyVerdicts);
const updateIssue = vi.mocked(api.updateBoekwachterIssue);

const base: BoekwachterIssue = {
  id: 'i1',
  ref: 'BW-4',
  fingerprint: 'f',
  path: 'src/save.ts',
  line: 12,
  severity: 'minor',
  category: 'bug',
  message: 'The loop stops one item early.',
  status: 'open',
  seen: true,
  stale: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-01T00:00:00.000Z',
};

function row(issue: BoekwachterIssue, runIssueAction = vi.fn(async () => {})) {
  render(
    <ul>
      <TrackedIssueItem
        issue={issue}
        fileName="save.ts"
        busy={false}
        onUpdateIssue={vi.fn()}
        runIssueAction={runIssueAction}
      />
    </ul>,
  );
  return runIssueAction;
}

beforeEach(() => {
  applyVerdicts.mockReset();
  updateIssue.mockReset();
});

describe('a tracked issue row', () => {
  it('shows who judged the issue and what they said', () => {
    row({
      ...base,
      status: 'dismissed',
      dismissalReason: 'not_an_issue',
      latestVerdict: {
        kind: 'not_a_bug',
        reason: 'handled_elsewhere',
        by: { kind: 'app', client: 'claude-code' },
        at: '2026-10-21T00:00:00.000Z',
        note: 'The caller pads the list.',
      },
    });
    expect(screen.getByText(/Not a bug · Claude Code/)).toBeTruthy();
    expect(screen.getByText(/The caller pads the list\./)).toBeTruthy();
  });

  it('says when an issue is low confidence', () => {
    row({ ...base, lowConfidence: true });
    expect(screen.getByText('Low confidence')).toBeTruthy();
  });

  it('gives a verdict with a reason and a note', async () => {
    const run = row(base);
    fireEvent.click(screen.getByRole('button', { name: 'Give a verdict' }));
    fireEvent.click(screen.getByRole('radio', { name: 'On purpose' }));
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: 'Deliberate: see the comment above.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save verdict' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(base, 'verdict', {
        verdict: {
          kind: 'not_a_bug',
          reason: 'intended',
          note: 'Deliberate: see the comment above.',
        },
        seen: true,
      }),
    );
  });

  it('sends "not worth fixing" without a reason', async () => {
    const run = row(base);
    fireEvent.click(screen.getByRole('button', { name: 'Give a verdict' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Not worth fixing' }));
    expect(screen.queryByRole('radiogroup', { name: 'Why it is not a bug' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save verdict' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(base, 'verdict', { verdict: { kind: 'nit' }, seen: true }),
    );
  });

  it('names each dismissal reason', () => {
    expect(issueStatusLabel('dismissed', 'wont_fix')).toBe("Won't fix");
    expect(issueStatusLabel('dismissed', 'duplicate')).toBe('Duplicate');
    expect(issueStatusLabel('dismissed', 'not_an_issue')).toBe('Not an issue');
  });
});

describe('sending a row change', () => {
  it('sends a verdict through the verdict route and surfaces a refusal', async () => {
    applyVerdicts.mockResolvedValue({
      results: [
        { ref: 'BW-4', outcome: 'refused', message: 'BW-4 is being worked on in task p/2.' },
      ],
      applied: 0,
      refused: 1,
    });
    await expect(
      sendIssuePatch('p', base, { verdict: { kind: 'confirmed' }, seen: true }),
    ).rejects.toThrow('task p/2');
    expect(applyVerdicts).toHaveBeenCalledWith('p', {
      verdicts: [{ ref: 'BW-4', kind: 'confirmed' }],
    });
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('sends a plain change as an update', async () => {
    await sendIssuePatch('p', base, { seen: false });
    expect(updateIssue).toHaveBeenCalledWith('p', { ref: 'BW-4', seen: false });
  });
});
