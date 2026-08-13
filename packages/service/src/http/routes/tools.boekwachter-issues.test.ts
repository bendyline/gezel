import type { BoekwachterIssue, Task } from '@bendyline/gezel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';

vi.mock('../../tasks/entry-dispatch.js', () => ({
  dispatchTaskEntry: vi.fn(),
}));

import { dispatchTaskEntry } from '../../tasks/entry-dispatch.js';
import { toolRoutes } from './tools.js';

const staleIssue: BoekwachterIssue = {
  id: 'issue-1',
  ref: 'BW-7',
  fingerprint: 'review-fingerprint',
  path: 'docs/guide.md',
  line: 26,
  severity: 'minor',
  category: 'clarity',
  message: 'The conclusion does not identify an owner.',
  status: 'open',
  seen: false,
  stale: true,
  createdAt: '2026-08-11T00:00:00.000Z',
  lastSeenAt: '2026-08-11T00:00:00.000Z',
};

describe('Boekwachter issue tool routes', () => {
  const getProject = vi.fn();
  const getGezel = vi.fn();
  const getBoekwachterIssue = vi.fn();
  const updateBoekwachterIssue = vi.fn();
  const getByRef = vi.fn();
  const create = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getProject.mockResolvedValue({ id: 'p1' });
    getGezel.mockImplementation(async (id: string) =>
      id === 'writer-1' ? { id, name: 'Willa', role: 'Writer' } : null,
    );
    getBoekwachterIssue.mockResolvedValue(staleIssue);
    updateBoekwachterIssue.mockImplementation(
      async (_projectId: string, _ref: string, patch: Record<string, unknown>) => ({
        ...staleIssue,
        ...patch,
      }),
    );
    getByRef.mockResolvedValue(null);
    create.mockResolvedValue({
      projectId: 'p1',
      num: 3,
      ref: 'p1/3',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'writer-1' },
      craftbook: { steps: [] },
    } as unknown as Task);
    vi.mocked(dispatchTaskEntry).mockResolvedValue({ enqueued: true, gezelId: 'writer-1' });
  });

  function app() {
    return toolRoutes({
      store: { getProject, getGezel },
      contentIndex: { getBoekwachterIssue, updateBoekwachterIssue },
      tasks: { getByRef, create },
      catalog: {},
      chat: {},
      taskRunner: {},
      history: {},
    } as unknown as ServiceContext);
  }

  it('updates read and lifecycle state by BW reference', async () => {
    const response = await app().request('/p1/tools/update-file-issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: 'BW-7',
        status: 'dismissed',
        dismissalReason: 'not_an_issue',
        seen: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(updateBoekwachterIssue).toHaveBeenCalledWith('p1', 'BW-7', {
      status: 'dismissed',
      dismissalReason: 'not_an_issue',
      seen: true,
    });
    await expect(response.json()).resolves.toMatchObject({
      issue: { ref: 'BW-7', status: 'dismissed', seen: true },
    });
  });

  it('creates and dispatches a linked specialist task with stale-anchor guidance', async () => {
    const message =
      '@writer, can you address BW-7 in docs/guide.md? Verify the current file before editing.';
    const response = await app().request('/p1/tools/fix-file-issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'BW-7', gezelId: 'writer-1', message }),
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        title: 'Address BW-7 in guide.md',
        assignee: { kind: 'gezel', gezelId: 'writer-1' },
        steps: [
          expect.objectContaining({
            terminal: true,
            prompt: expect.stringMatching(
              /BW-7[\s\S]*historical evidence[\s\S]*docs\/guide\.md[\s\S]*previousLine[\s\S]*26/,
            ),
          }),
        ],
      }),
      { origin: { kind: 'boekwachter-issue', issueRef: 'BW-7', path: 'docs/guide.md' } },
    );
    expect(updateBoekwachterIssue).toHaveBeenCalledWith('p1', 'BW-7', {
      status: 'in_progress',
      seen: true,
      taskRef: 'p1/3',
    });
    expect(dispatchTaskEntry).toHaveBeenCalledWith(
      expect.objectContaining({ taskRunner: expect.anything() }),
      expect.objectContaining({ ref: 'p1/3' }),
    );
    await expect(response.json()).resolves.toMatchObject({
      issue: { ref: 'BW-7', status: 'in_progress', taskRef: 'p1/3' },
      taskRef: 'p1/3',
      gezelId: 'writer-1',
      gezelName: 'Willa',
      enqueued: true,
    });
  });

  it('does not create a duplicate task when the linked task is still active', async () => {
    getBoekwachterIssue.mockResolvedValue({
      ...staleIssue,
      status: 'in_progress',
      taskRef: 'p1/2',
    });
    getByRef.mockResolvedValue({
      ref: 'p1/2',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'writer-1' },
    });
    const response = await app().request('/p1/tools/fix-file-issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'BW-7', gezelId: 'writer-1', message: 'Please address it.' }),
    });

    expect(response.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ taskRef: 'p1/2' });
  });
});
