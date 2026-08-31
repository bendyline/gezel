import type { SecurityFindingWire, Task } from '@bendyline/gezel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';

vi.mock('../../gezels/ensure.js', () => ({
  ensureGezel: vi.fn(),
}));
vi.mock('../../tasks/entry-dispatch.js', () => ({
  dispatchTaskEntry: vi.fn(),
}));

import { ensureGezel } from '../../gezels/ensure.js';
import { dispatchTaskEntry } from '../../tasks/entry-dispatch.js';
import { toolRoutes } from './tools.js';

const finding: SecurityFindingWire = {
  fingerprint: 'sink.eval:src/a.ts:7',
  path: 'src/a.ts',
  line: 7,
  ruleId: 'sink.eval',
  category: 'injection',
  severity: 'high',
  source: 'builtin',
  title: 'Dynamic execution',
  evidence: 'eval(untrusted)',
  status: 'open',
};

describe('finding lifecycle tool routes', () => {
  const getProject = vi.fn();
  const getGezel = vi.fn();
  const findingByFingerprint = vi.fn();
  const setFindingStatus = vi.fn();
  const getByRef = vi.fn();
  const create = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getProject.mockResolvedValue({ id: 'p1' });
    getGezel.mockResolvedValue(null);
    findingByFingerprint.mockResolvedValue(finding);
    setFindingStatus.mockResolvedValue(true);
    getByRef.mockResolvedValue(null);
    vi.mocked(ensureGezel).mockResolvedValue({
      gezelId: 'dev-1',
      name: 'Ada',
      role: 'Developer',
      action: 'reused',
    });
    vi.mocked(dispatchTaskEntry).mockResolvedValue({ enqueued: true, gezelId: 'dev-1' });
  });

  function app() {
    const task = {
      projectId: 'p1',
      num: 1,
      ref: 'p1/1',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'dev-1' },
      craftbook: { steps: [] },
    } as unknown as Task;
    create.mockResolvedValue(task);
    return toolRoutes({
      store: { getProject, getGezel },
      contentIndex: { findingByFingerprint, setFindingStatus },
      tasks: { getByRef, create },
      catalog: {},
      chat: {},
      taskRunner: {},
      history: {},
    } as unknown as ServiceContext);
  }

  it('marks a finding resolved', async () => {
    const response = await app().request('/p1/tools/resolve-finding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: finding.fingerprint }),
    });

    expect(response.status).toBe(200);
    expect(setFindingStatus).toHaveBeenCalledWith('p1', finding.fingerprint, 'resolved');
    await expect(response.json()).resolves.toEqual({ resolved: true });
  });

  it('creates and dispatches a terminal developer task for a finding', async () => {
    const response = await app().request('/p1/tools/delegate-finding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: finding.fingerprint }),
    });

    expect(response.status).toBe(200);
    expect(ensureGezel).toHaveBeenCalledWith(
      expect.objectContaining({ opts: { jobTitle: 'software developer' } }),
    );
    expect(create).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        assignee: { kind: 'gezel', gezelId: 'dev-1' },
        steps: [
          expect.objectContaining({
            terminal: true,
            prompt: expect.stringContaining('untrusted evidence'),
          }),
        ],
      }),
    );
    expect(setFindingStatus).toHaveBeenCalledWith('p1', finding.fingerprint, 'in_progress', 'p1/1');
    expect(dispatchTaskEntry).toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      taskRef: 'p1/1',
      gezelId: 'dev-1',
      gezelName: 'Ada',
      enqueued: true,
    });
  });

  it('drafts the targeted fix as a diffpack when managed workspace writes are off', async () => {
    getProject.mockResolvedValue({
      id: 'p1',
      workingDir: 'D:/readonly-checkout',
      managedWorkspaceWritePolicy: 'deny',
    });

    const response = await app().request('/p1/tools/delegate-finding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: finding.fingerprint }),
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        title: 'Resolve high finding in a.ts',
        assignee: { kind: 'gezel', gezelId: 'dev-1' },
      }),
      { draftsDiffpack: true },
    );
  });
});
