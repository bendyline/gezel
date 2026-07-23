import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  findNearMissDeliverable,
  findWorkspaceDeliverableNearMiss,
  pollHtmlSniff,
  provisionScenarioGezel,
  runtimeReportForGate,
  workspaceContentRevision,
} from './helpers.ts';

describe('provisionScenarioGezel', () => {
  it('uses a role-suffixed name when the preferred id belongs to the active Meester', async () => {
    const logs: string[] = [];
    const client = {
      listGezels: vi.fn().mockResolvedValue({
        gezels: [{ id: 'tamsin', name: 'Tamsin', role: 'Meester' }],
      }),
      createGezel: vi.fn().mockResolvedValue({
        id: 'tamsin-researcher',
        name: 'Tamsin (Researcher)',
        role: 'Researcher',
      }),
    } as unknown as GezelClient;

    await expect(
      provisionScenarioGezel(
        { client, meesterId: 'tamsin', log: (line) => logs.push(line) },
        { preferredName: 'Tamsin', role: 'Researcher', label: 'researcher' },
      ),
    ).resolves.toEqual({ id: 'tamsin-researcher', name: 'Tamsin (Researcher)' });

    expect(client.createGezel).toHaveBeenCalledWith({
      name: 'Tamsin (Researcher)',
      role: 'Researcher',
    });
    expect(logs.join('\n')).toContain('collides with the active Meester');
  });

  it('does not reuse a role-compatible gezel when that gezel is the active Meester', async () => {
    const client = {
      listGezels: vi.fn().mockResolvedValue({
        gezels: [{ id: 'riley', name: 'Riley', role: 'Developer' }],
      }),
      createGezel: vi.fn().mockResolvedValue({
        id: 'riley-developer',
        name: 'Riley (Developer)',
        role: 'Developer',
      }),
    } as unknown as GezelClient;

    await expect(
      provisionScenarioGezel(
        { client, meesterId: 'riley', log: () => {} },
        { preferredName: 'Riley', role: 'Developer' },
      ),
    ).resolves.toMatchObject({ id: 'riley-developer' });
  });

  it('reuses an existing role-compatible non-Meester specialist', async () => {
    const client = {
      listGezels: vi.fn().mockResolvedValue({
        gezels: [
          { id: 'meester-1', name: 'Zephyr', role: 'Meester' },
          { id: 'theo', name: 'Theo', role: 'Developer' },
        ],
      }),
      createGezel: vi.fn(),
    } as unknown as GezelClient;

    await expect(
      provisionScenarioGezel(
        { client, meesterId: 'meester-1', log: () => {} },
        { preferredName: 'Theo', role: 'Developer' },
      ),
    ).resolves.toEqual({ id: 'theo', name: 'Theo' });
    expect(client.createGezel).not.toHaveBeenCalled();
  });

  it('reuses the deterministic collision-safe specialist on setup retry', async () => {
    const client = {
      listGezels: vi.fn().mockResolvedValue({
        gezels: [
          { id: 'tamsin', name: 'Tamsin', role: 'Meester' },
          { id: 'tamsin-researcher', name: 'Tamsin (Researcher)', role: 'Researcher' },
        ],
      }),
      createGezel: vi.fn(),
    } as unknown as GezelClient;

    await expect(
      provisionScenarioGezel(
        { client, meesterId: 'tamsin', log: () => {} },
        { preferredName: 'Tamsin', role: 'Researcher' },
      ),
    ).resolves.toEqual({ id: 'tamsin-researcher', name: 'Tamsin (Researcher)' });
    expect(client.createGezel).not.toHaveBeenCalled();
  });
});

describe('runtimeReportForGate', () => {
  it('promotes collected page errors into a failed runtime assertion', () => {
    const report = runtimeReportForGate({
      ran: true,
      passed: ['render-surface-present'],
      failed: [],
      pageErrors: ['ReferenceError: gameState is not defined'],
    });
    expect(report.failed).toEqual([
      expect.objectContaining({
        name: 'no-page-errors',
        why: expect.stringContaining('ReferenceError'),
      }),
    ]);
  });

  it('leaves bootstrap failures advisory', () => {
    const report = runtimeReportForGate({
      ran: false,
      passed: [],
      failed: [],
      pageErrors: ['launcher noise'],
      bootstrapError: 'chromium unavailable',
    });
    expect(report.failed).toEqual([]);
  });
});

describe('workspaceContentRevision', () => {
  it('changes when an imported helper changes and is stable across listing order', async () => {
    const contents = new Map([
      ['src/machine.ts', "export { build } from './helper.ts';"],
      ['src/helper.ts', 'export const build = () => 1;'],
      ['node_modules/noise/index.js', 'ignored dependency'],
      ['notes.md', 'ignored'],
    ]);
    const paths = ['notes.md', 'node_modules/noise/index.js', 'src/helper.ts', 'src/machine.ts'];
    const client = {
      listProjectWorkspace: vi.fn().mockImplementation(async () => ({
        files: paths.map((path) => ({ name: path, path, isDirectory: false })),
      })),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(
          async (_projectId: string, path: string) => new Blob([contents.get(path) ?? '']),
        ),
    } as unknown as GezelClient;

    const first = await workspaceContentRevision(client, 'p1', /\.(?:ts|json)$/);
    paths.reverse();
    const reordered = await workspaceContentRevision(client, 'p1', /\.(?:ts|json)$/);
    expect(reordered).toBe(first);

    contents.set('src/helper.ts', 'export const build = () => 2;');
    const helperChanged = await workspaceContentRevision(client, 'p1', /\.(?:ts|json)$/);
    expect(helperChanged).not.toBe(first);

    contents.set('notes.md', 'still ignored');
    const ignoredChanged = await workspaceContentRevision(client, 'p1', /\.(?:ts|json)$/);
    expect(ignoredChanged).toBe(helperChanged);

    const dependencyBefore = await workspaceContentRevision(client, 'p1', /\.(?:ts|js|json)$/);
    contents.set('node_modules/noise/index.js', 'different ignored dependency');
    const dependencyAfter = await workspaceContentRevision(client, 'p1', /\.(?:ts|js|json)$/);
    expect(dependencyAfter).toBe(dependencyBefore);
  });
});

describe('pollHtmlSniff', () => {
  it('logs a sniff denominator when the scenario exposes scoreMax', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'default' }, { id: 'pet-shop-website' }],
      }),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [{ name: 'index.html', path: 'index.html', isDirectory: false }],
      }),
      listProjectArtifacts: vi.fn().mockResolvedValue({ files: [] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockResolvedValue(new Blob(['<html><body>pet shop</body></html>'])),
    } as unknown as GezelClient;
    const lines: string[] = [];
    const ctx: EvalContext = {
      client,
      meesterId: 'meester-1',
      log: () => {},
      logChanged: (_key, line) => lines.push(line),
    };

    const result = await pollHtmlSniff({
      ctx,
      sniff: () => ({
        ok: true,
        signals: ['pet-vocab', 'store-vocab', 'working-image', 'image-asset'],
        score: 4,
        scoreMax: 5,
      }),
      getExtraContext: async () => undefined,
      missingDeliverablePath: 'index.html',
    });

    expect(result).toMatchObject({ done: true, success: true });
    expect(lines).toEqual([
      expect.stringContaining(
        'bytes=34 score=4/5 signals=pet-vocab,store-vocab,working-image,image-asset',
      ),
    ]);
  });

  it('posts missing-deliverable feedback when a project exists but no HTML exists', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'default' }, { id: 'tic-tac-toe-game' }],
      }),
      listProjectWorkspace: vi.fn().mockResolvedValue({ files: [] }),
      listProjectArtifacts: vi.fn().mockResolvedValue({ files: [] }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [{ id: 's1', gezelId: 'voorman-1', lastActivityAt: '2026-06-02T05:00:00Z' }],
      }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    } as unknown as GezelClient & { messageGezel: ReturnType<typeof vi.fn> };
    const ctx: EvalContext = {
      client,
      meesterId: 'meester-1',
      log: () => {},
      logChanged: () => {},
    };

    const result = await pollHtmlSniff({
      ctx,
      sniff: () => ({ ok: false, signals: [], score: 0 }),
      getExtraContext: async () => undefined,
      missingDeliverablePath: 'index.html',
      missingDeliverableFeedback: { minPolls: 1 },
    });

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel.mock.calls[0]![1].text).toContain('writeFile({ path: "index.html"');
  });

  it('mentions a near-miss plan file when no HTML deliverable exists', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'default' }, { id: 'tic-tac-toe-game' }],
      }),
      listProjectWorkspace: vi.fn().mockResolvedValue({ files: [] }),
      listProjectArtifacts: vi.fn().mockResolvedValue({
        files: [{ name: 'index_plan.md', path: 'planning/index_plan.md', isDirectory: false }],
      }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [{ id: 's1', gezelId: 'voorman-1', lastActivityAt: '2026-06-02T05:00:00Z' }],
      }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    } as unknown as GezelClient & { messageGezel: ReturnType<typeof vi.fn> };
    const ctx: EvalContext = {
      client,
      meesterId: 'meester-1',
      log: () => {},
      logChanged: () => {},
    };

    const result = await pollHtmlSniff({
      ctx,
      sniff: () => ({ ok: false, signals: [], score: 0 }),
      getExtraContext: async () => undefined,
      missingDeliverablePath: 'index.html',
      missingDeliverableFeedback: { minPolls: 1 },
    });

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const text = client.messageGezel.mock.calls[0]![1].text;
    expect(text).toContain('index_plan.md');
    expect(text).toContain('artifacts/planning/index_plan.md');
    expect(text).toContain('wrong deliverable path or location');
    expect(text).toContain('writeFile({ path: "index.html"');
  });

  it('does not post missing-deliverable feedback for empty side projects once any HTML exists', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'default' }, { id: 'empty-side-project' }, { id: 'pet-shop-website' }],
      }),
      listProjectWorkspace: vi.fn().mockImplementation((projectId: string) =>
        Promise.resolve({
          files:
            projectId === 'pet-shop-website'
              ? [{ name: 'index.html', path: 'index.html', isDirectory: false }]
              : [],
        }),
      ),
      listProjectArtifacts: vi.fn().mockResolvedValue({ files: [] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockResolvedValue(new Blob(['<html><body>draft</body></html>'])),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [{ id: 's1', gezelId: 'voorman-1', lastActivityAt: '2026-06-02T05:00:00Z' }],
      }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    } as unknown as GezelClient & { messageGezel: ReturnType<typeof vi.fn> };
    const ctx: EvalContext = {
      client,
      meesterId: 'meester-1',
      log: () => {},
      logChanged: () => {},
    };

    const result = await pollHtmlSniff({
      ctx,
      sniff: () => ({
        ok: false,
        signals: ['structured-page'],
        score: 1,
        missingRequiredSignals: ['working-image'],
      }),
      getExtraContext: async () => undefined,
      missingDeliverablePath: 'index.html',
      missingDeliverableFeedback: { minPolls: 1 },
    });

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel.mock.calls[0]![1].text).toContain('working-image');
    expect(client.messageGezel.mock.calls[0]![1].text).not.toContain(
      'There is still **no `index.html`**',
    );
  });
});

describe('findNearMissDeliverable', () => {
  it('treats the exact file under artifacts as a near miss when workspace is required', () => {
    const nearMiss = findNearMissDeliverable(
      [
        {
          projectId: 'p1',
          surface: 'artifacts',
          filePath: 'customer-notice.md',
          rooted: 'artifacts/customer-notice.md',
        },
      ],
      'customer-notice.md',
      { requiredSurface: 'workspace' },
    );

    expect(nearMiss).toEqual({
      path: 'customer-notice.md',
      location: 'artifacts/customer-notice.md',
    });
  });

  it('ignores the exact workspace file when workspace is required', () => {
    const nearMiss = findNearMissDeliverable(
      [
        {
          projectId: 'p1',
          surface: 'workspace',
          filePath: 'customer-notice.md',
          rooted: 'workspace/customer-notice.md',
        },
      ],
      'customer-notice.md',
      { requiredSurface: 'workspace' },
    );

    expect(nearMiss).toBeUndefined();
  });
});

describe('findWorkspaceDeliverableNearMiss', () => {
  it('detects a shared document with the expected path as a wrong-location near miss', async () => {
    const client = {
      listProjectWorkspace: vi.fn().mockResolvedValue({ files: [] }),
      listProjectArtifacts: vi.fn().mockResolvedValue({ files: [] }),
      listDocuments: vi.fn().mockResolvedValue({
        files: [{ name: 'customer-notice.md', path: 'customer-notice.md', isDirectory: false }],
      }),
      listHistory: vi.fn().mockResolvedValue({ entries: [] }),
    } as unknown as GezelClient;

    const nearMiss = await findWorkspaceDeliverableNearMiss(
      client,
      'driftwater-outage-notice',
      'customer-notice.md',
    );

    expect(nearMiss).toEqual({
      path: 'customer-notice.md',
      location: 'documents/customer-notice.md',
    });
  });

  it('prefers an exact shared-document near miss over a stale workspace draft', async () => {
    const client = {
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [{ name: 'old-notice.md', path: 'drafts/old-notice.md', isDirectory: false }],
      }),
      listProjectArtifacts: vi.fn().mockResolvedValue({ files: [] }),
      listDocuments: vi.fn().mockResolvedValue({
        files: [{ name: 'customer-notice.md', path: 'customer-notice.md', isDirectory: false }],
      }),
      listHistory: vi.fn().mockResolvedValue({ entries: [] }),
    } as unknown as GezelClient;

    const nearMiss = await findWorkspaceDeliverableNearMiss(
      client,
      'driftwater-outage-notice',
      'customer-notice.md',
    );

    expect(nearMiss).toEqual({
      path: 'customer-notice.md',
      location: 'documents/customer-notice.md',
    });
  });

  it('detects write_document history as a wrong-location near miss when listings miss it', async () => {
    const client = {
      listProjectWorkspace: vi.fn().mockResolvedValue({ files: [] }),
      listProjectArtifacts: vi.fn().mockResolvedValue({ files: [] }),
      listDocuments: vi.fn().mockResolvedValue({ files: [] }),
      listHistory: vi.fn().mockResolvedValue({
        entries: [
          {
            entryType: 'event',
            kind: 'document.created',
            details: { path: 'customer-notice.md' },
          },
        ],
      }),
    } as unknown as GezelClient;

    const nearMiss = await findWorkspaceDeliverableNearMiss(
      client,
      'driftwater-outage-notice',
      'customer-notice.md',
    );

    expect(nearMiss).toEqual({
      path: 'customer-notice.md',
      location: 'documents/customer-notice.md',
    });
  });
});
