import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));

const { makeReportActionFenceRenderers } = await import('./ReportActionFence.js');
const { refreshReportActions } = await import('./reportActionsStore.js');
const { api } = await import('../../api.js');

const FIRE_BODY = `kind: fire-craftbook
id: audit
title: Run the accessibility audit
reason: Templates changed overnight.
craftbookId: a11y-audit`;

function renderFence(body: string) {
  const renderers = makeReportActionFenceRenderers({
    projectId: 'p1',
    reportPath: 'night-shift-report.md',
  });
  const node = renderers['gezel-action']!({
    lang: 'gezel-action',
    value: body,
    mode: 'read',
  });
  return render(node as ReactElement);
}

beforeEach(async () => {
  vi.mocked(api.getReportActions).mockReset();
  vi.mocked(api.fireReportAction).mockReset();
  vi.mocked(api.dismissReportAction).mockReset();
  vi.mocked(api.getReportActions).mockResolvedValue({
    actions: [
      {
        action: {
          kind: 'fire-craftbook',
          title: 'Run the accessibility audit',
          craftbookId: 'a11y-audit',
        },
        id: 'audit',
        contentHash: 'x',
        state: 'suggested',
      },
    ],
    issues: [],
    stale: [],
  });
  await refreshReportActions('p1', 'night-shift-report.md').catch(() => {});
});

describe('ReportActionFence', () => {
  it('renders a suggested card and fires it', async () => {
    vi.mocked(api.fireReportAction).mockResolvedValue({
      record: {
        actionId: 'audit',
        reportPath: 'night-shift-report.md',
        kind: 'fire-craftbook',
        contentHash: 'x',
        firstSeenAt: 'now',
        state: 'fired',
        taskRef: 'p1/7',
      },
      taskRef: 'p1/7',
    });
    renderFence(FIRE_BODY);
    expect(await screen.findByText('Run the accessibility audit')).toBeInTheDocument();
    expect(screen.getByText(/Craftbook: a11y-audit/)).toBeInTheDocument();

    vi.mocked(api.getReportActions).mockResolvedValue({
      actions: [
        {
          action: {
            kind: 'fire-craftbook',
            title: 'Run the accessibility audit',
            craftbookId: 'a11y-audit',
          },
          id: 'audit',
          contentHash: 'x',
          state: 'fired',
          taskRef: 'p1/7',
        },
      ],
      issues: [],
      stale: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fire' }));
    await waitFor(() =>
      expect(api.fireReportAction).toHaveBeenCalledWith('p1', {
        path: 'night-shift-report.md',
        actionId: 'audit',
      }),
    );
    expect(await screen.findByText(/Task running — p1\/7/)).toBeInTheDocument();
  });

  it('dismisses a suggested card', async () => {
    vi.mocked(api.dismissReportAction).mockResolvedValue({ record: {} as never });
    renderFence(FIRE_BODY);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(api.dismissReportAction).toHaveBeenCalledWith('p1', {
        path: 'night-shift-report.md',
        actionId: 'audit',
      }),
    );
  });

  it('renders an unreadable block with the raw body available', async () => {
    renderFence('- not\n- a mapping');
    expect(await screen.findByText('Unreadable action block')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show raw block' }));
    expect(screen.getByText(/- not/)).toBeInTheDocument();
  });

  it('shows per-edit rows for apply-edits actions', async () => {
    vi.mocked(api.getReportActions).mockResolvedValue({ actions: [], issues: [], stale: [] });
    await refreshReportActions('p1', 'night-shift-report.md');
    renderFence(
      [
        'kind: apply-edits',
        'id: fix-headers',
        'title: Harden headers',
        'edits:',
        '  - path: src/server.ts',
        '    diffArtifact: night-shift-report/edits/h.diff',
      ].join('\n'),
    );
    expect(await screen.findByText('Harden headers')).toBeInTheDocument();
    expect(screen.getByText('src/server.ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply edits' })).toBeInTheDocument();
  });
});
