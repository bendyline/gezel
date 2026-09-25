import { describe, expect, it, vi } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  API_DEFINITION_PATH,
  API_USE_PATH,
  LATE_DEFECT_PATH,
  buildLargePrArtifacts,
  largePrReviewScenario,
} from './large-pr-review.js';

describe('large-pr-review fixture', () => {
  it('is larger than the old bridge cap and contains 120 per-file records', () => {
    const artifacts = buildLargePrArtifacts();
    const records = artifacts.filter((artifact) => artifact.path.includes('/files/'));
    expect(records).toHaveLength(120);
    expect(artifacts.reduce((sum, artifact) => sum + artifact.content.length, 0)).toBeGreaterThan(
      80_000,
    );
  });

  it('places API use early, its definition late, and the real defect last', () => {
    const records = buildLargePrArtifacts().filter((artifact) => artifact.path.includes('/files/'));
    expect(records[0]?.content).toContain(`path: ${API_USE_PATH}`);
    expect(records.at(-2)?.content).toContain(`path: ${API_DEFINITION_PATH}`);
    expect(records.at(-1)?.content).toContain(`path: ${LATE_DEFECT_PATH}`);
    expect(records.at(-1)?.content).toContain('+  return true;');
  });

  it('asks for exact complete coverage and cross-file verification', () => {
    expect(largePrReviewScenario.prompt).toContain('Coverage: 120/120 changed files');
    expect(largePrReviewScenario.prompt).toContain('find_symbol');
    expect(largePrReviewScenario.prompt.toLowerCase()).toContain('do not modify source');
  });
});

describe('large-pr-review missing-ledger feedback', () => {
  const projectId = 'large-pr-review-eval';

  function fixture(sessions: Array<{ id: string; gezelId: string; lastActivityAt: string }>) {
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: projectId, name: 'Large PR Review Eval' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation((_id: string, path: string) =>
          path === 'pr-review.md'
            ? Promise.resolve(new Blob(['# Review\nCoverage: 120/120 changed files']))
            : Promise.reject(new Error('404 not found')),
        ),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [{ name: 'pr-review.md', path: 'pr-review.md', isDirectory: false }],
      }),
      // The reviewer wrote the ledger — to the artifacts drawer.
      listProjectArtifacts: vi.fn().mockResolvedValue({
        files: [
          {
            name: 'pr-review-coverage.json',
            path: 'pr-review-coverage.json',
            isDirectory: false,
          },
          {
            name: 'pr-52-files.json',
            path: 'data/github-pulls/pr-52/attachments/001/pr-52-files.json',
            isDirectory: false,
          },
        ],
      }),
      listDocuments: vi.fn().mockResolvedValue({ files: [] }),
      listHistory: vi.fn().mockResolvedValue({ entries: [] }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: sessions.map((session) => ({ ...session, projectId })),
      }),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [
          { id: 'rina', role: 'Reviewer' },
          { id: 'meester-1', role: 'Meester' },
        ],
      }),
      listInflightTurns: vi.fn().mockResolvedValue({ inflight: [] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true, sessionId: 'rina-s' }),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
      ensureGezel: vi.fn().mockResolvedValue({ gezelId: 'ekaterine', role: 'Developer' }),
    };
    const ctx = {
      client,
      meesterId: 'meester-1',
      log: () => {},
      logChanged: () => {},
      recordSniff: () => {},
    } as unknown as EvalContext;
    return { client, ctx };
  }

  // INCIDENT (2026-09-23 smoke): the ledger sat at
  // artifacts/pr-review-coverage.json (16.5 KB) while the trial reported it
  // "absent 102 polls"; the harness recruited a new Developer at 97 minutes
  // instead of telling the reviewer to copy it into the workspace.
  it('nudges the active reviewer with the copy-to-workspace fast path', async () => {
    const { client, ctx } = fixture([
      { id: 'rina-s', gezelId: 'rina', lastActivityAt: '2026-09-23T21:00:00Z' },
    ]);
    for (let poll = 0; poll < 24; poll++) {
      await expect(largePrReviewScenario.successCheck(ctx)).resolves.toEqual({ done: false });
    }
    expect(client.ensureGezel).not.toHaveBeenCalled();
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('rina');
    expect(body.projectId).toBe(projectId);
    expect(body.text).toContain(
      'copy_artifact_to_workspace({ source: "pr-review-coverage.json", dest: "pr-review-coverage.json" })',
    );
    expect(body.text).toContain('artifacts/pr-review-coverage.json');
  });

  it('never grades the artifacts copy as the workspace deliverable', async () => {
    const { ctx } = fixture([
      { id: 'rina-s', gezelId: 'rina', lastActivityAt: '2026-09-23T21:00:00Z' },
    ]);
    await expect(largePrReviewScenario.successCheck(ctx)).resolves.toEqual({ done: false });
  });
});
