import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import { craftbookMissingDeliverableRepairDirective } from './craftbooks/scenario.ts';
import type { CraftbookEvalSpec } from './craftbooks/types.ts';
import {
  buildReEngageNudge,
  buildRetryLoopNudge,
  recoveryArtifactPathForSniff,
  retryLoopSniffKey,
} from './runner.ts';
import { postMissingDeliverableFeedback } from './sniff-feedback.ts';
import type { EvalContext } from './types.ts';

/**
 * Every harness kick and nudge used to assume a WORKSPACE deliverable. A
 * craftbook step whose result lives in the artifacts drawer has no
 * `write_file`, so "Your next tool call MUST be `write_file(...)`" named a
 * tool its session did not hold (bug-fix-tdd `reproduce`, api-contract-review
 * `review`, 2026-09-30). These pin the drawer variants.
 */
describe('retry-loop and re-engage kicks for a drawer deliverable', () => {
  const artifactSniff = {
    key: 'craftbook-api-contract-review',
    score: 3,
    bytes: 0,
    failReason: 'tasks/1/review.md is missing',
    deliverableMissing: true,
    repairArtifactPath: 'tasks/1/review.md',
  };

  it('names write_artifact with the drawer path when the deliverable is missing', () => {
    const text = buildRetryLoopNudge({
      filePath: null,
      artifactPath: recoveryArtifactPathForSniff(artifactSniff),
      artifactExists: false,
    });
    expect(text).toContain('`write_artifact({ path: "tasks/1/review.md", content:');
    expect(text).toContain('artifacts drawer');
    expect(text).not.toContain('write_file');
  });

  it('names read_artifact + write_artifact when the drawer file exists but fails', () => {
    const text = buildRetryLoopNudge({
      filePath: null,
      artifactPath: 'tasks/1/review.md',
      artifactExists: true,
    });
    expect(text).toContain('EXISTS in the artifacts drawer');
    expect(text).toContain('read_artifact');
    expect(text).toContain('write_artifact({ path: "tasks/1/review.md"');
    expect(text).not.toContain('write_file');
    expect(text).not.toContain('replace_in_file');
  });

  it('keeps the workspace wording when no drawer path was selected', () => {
    const text = buildRetryLoopNudge({
      filePath: 'index.html',
      artifactPath: null,
      artifactExists: false,
    });
    expect(text).toContain('write_file({ path: "index.html"');
    expect(text).not.toContain('write_artifact({');
  });

  it('routes the re-engage nudge to the drawer too', () => {
    const missing = buildReEngageNudge({ sniff: artifactSniff, downstream: true });
    expect(missing.filePath).toBeNull();
    expect(missing.text).toContain('write_artifact({ path: "tasks/1/review.md"');
    expect(missing.text).not.toContain('write_file');

    const failing = buildReEngageNudge({
      sniff: { ...artifactSniff, bytes: 900, deliverableMissing: false },
      downstream: true,
    });
    expect(failing.text).toContain('is in the artifacts drawer but has not passed yet');
    expect(failing.text).toContain('tasks/1/review.md is missing');
    expect(failing.text).not.toContain('replace_in_file');

    const coordinator = buildReEngageNudge({ sniff: artifactSniff, downstream: false });
    expect(coordinator.text).toContain('has not reached the artifacts drawer');
    expect(coordinator.text).not.toContain('project workspace');
  });

  it('keeps the drawer path out of the retry-loop plateau key', () => {
    const { repairArtifactPath: _drop, ...withoutPath } = artifactSniff;
    expect(retryLoopSniffKey(artifactSniff)).toBe(retryLoopSniffKey(withoutPath));
  });
});

describe('missing-deliverable nudge for a drawer deliverable', () => {
  function makeClient() {
    return {
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 's-dev',
            gezelId: 'dev-1',
            projectId: 'orderly-pricing',
            lastActivityAt: '2026-09-30T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [] }),
      listInflightTurns: vi.fn().mockResolvedValue({ inflight: [] }),
      ensureGezel: vi.fn(),
      sendToChatSession: vi.fn().mockResolvedValue({ accepted: true }),
    };
  }

  it('names the drawer and write_artifact, and attaches no workspace contract', async () => {
    const client = makeClient();
    const ctx: EvalContext = {
      client: client as unknown as GezelClient,
      meesterId: 'meester-1',
      log: () => {},
      logChanged: () => {},
    };
    await postMissingDeliverableFeedback(ctx, 'tasks/1/repro.md', {
      minPolls: 1,
      projectId: 'orderly-pricing',
      targetGezelId: 'dev-1',
      expectedSurface: 'artifact',
    });

    const [, body] = client.messageGezel.mock.calls[0]!;
    expect(body.text).toContain('no `tasks/1/repro.md`** in the artifacts drawer');
    expect(body.text).toContain('write_artifact({ path: "tasks/1/repro.md", content:');
    expect(body.text).not.toContain('write_file');
    expect(body.text).not.toContain('in the workspace');
    expect(body.expectedDeliverable).toBeUndefined();
    expect(body.fileTurnIntent).toBeUndefined();
  });

  it('keeps the workspace contract for a workspace deliverable', async () => {
    const client = makeClient();
    const ctx: EvalContext = {
      client: client as unknown as GezelClient,
      meesterId: 'meester-1',
      log: () => {},
      logChanged: () => {},
    };
    await postMissingDeliverableFeedback(ctx, 'out/report.md', {
      minPolls: 1,
      projectId: 'orderly-pricing',
      targetGezelId: 'dev-1',
    });
    const [, body] = client.messageGezel.mock.calls[0]!;
    expect(body.text).toContain('write_file({ path: "out/report.md"');
    expect(body.fileTurnIntent).toEqual({ kind: 'create-file', path: 'out/report.md' });
  });
});

describe('craftbook missing-deliverable repair directive', () => {
  const spec = {
    scenarioId: 'craftbook-bug-fix-tdd',
    craftbookId: 'bug-fix-tdd',
    prompt: 'Fix the bug.',
    success: {
      deliverables: [
        { path: 'tasks/1/repro.md', kind: 'markdown-notes', artifact: true, minBytes: 500 },
        { path: 'tasks/1/diagnosis.md', kind: 'markdown-notes', artifact: true, minBytes: 600 },
      ],
    },
  } as unknown as CraftbookEvalSpec;

  it('names write_artifact for a failing drawer deliverable instead of fencing it off', () => {
    const text = craftbookMissingDeliverableRepairDirective(spec, ['tasks/1/repro.md is missing']);
    expect(text).toContain('write_artifact({ path: "tasks/1/repro.md", content:');
    expect(text).toContain(
      'Already passing — do NOT rewrite, shorten, or re-create: `tasks/1/diagnosis.md`',
    );
    expect(text).not.toMatch(/Already passing[^\n]*repro\.md/);
    expect(text).not.toContain('write_file');
  });
});
