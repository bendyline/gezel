import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isGitInstalled, runGit } from '../../git/git.js';
import { type RunningService, startService } from '../../service.js';

/**
 * Full-service integration for the code-review routes: real wiring
 * (CodeReviewManager, GitManager snapshots, TaskManager, settle hook)
 * over real HTTP, with a local bare repo standing in for GitHub and the
 * mock provider standing in for the LLM.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let scratch: string;
let httpFetch: typeof fetch;
let projectId: string;
let bareProjectId: string;
let gitAvailable = true;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  gitAvailable = await isGitInstalled();
  home = await mkdtemp(join(tmpdir(), 'gezel-git-reviews-'));
  scratch = await mkdtemp(join(tmpdir(), 'gezel-git-reviews-scratch-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  // A project with no repo link at all — the 400 guard case.
  const bare = await svc.context.store.createProject({ name: 'no-repo' });
  bareProjectId = bare.id;

  if (!gitAvailable) return;
  // Local bare upstream + seeded main + the project's worktree checkout.
  const upstream = join(scratch, 'upstream.git');
  await mkdir(upstream, { recursive: true });
  await runGit(['init', '--bare', '-q'], { cwd: upstream });
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: upstream });
  const seed = join(scratch, 'seed');
  await mkdir(seed, { recursive: true });
  await runGit(['init', '-q'], { cwd: seed });
  await runGit(['config', 'user.email', 'seed@example.com'], { cwd: seed });
  await runGit(['config', 'user.name', 'seed'], { cwd: seed });
  await writeFile(join(seed, 'README.md'), 'hello\n', 'utf8');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'init', '-q'], { cwd: seed });
  await runGit(['branch', '-M', 'main'], { cwd: seed });
  await runGit(['remote', 'add', 'origin', upstream], { cwd: seed });
  await runGit(['push', '-u', 'origin', 'main', '-q'], { cwd: seed });

  const project = await svc.context.store.createProject({
    name: 'reviewed',
    github: { url: upstream },
  });
  projectId = project.id;
  const workdir = await svc.context.git.addProjectWorktree({
    projectId,
    url: upstream,
    ref: 'main',
  });
  await runGit(['config', 'user.email', 'worker@example.com'], { cwd: workdir });
  await runGit(['config', 'user.name', 'worker'], { cwd: workdir });
  // The unsaved change a commit review snapshots.
  await writeFile(join(workdir, 'README.md'), 'hello\nchanged line\n', 'utf8');
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  const opts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  await rm(home, opts).catch(() => {});
  await rm(scratch, opts).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('code review routes', () => {
  it('starts a commit review, blocks a duplicate, lists, reads, and cancels it', async () => {
    if (!gitAvailable) return;
    const started = await call('POST', `/api/projects/${projectId}/git/reviews`, {
      kind: 'commit',
    });
    expect(started.status).toBe(200);
    const { review } = (await started.json()) as { review: Record<string, unknown> };
    expect(review.status).toBe('running');
    expect(review.kind).toBe('commit');
    expect(typeof review.taskRef).toBe('string');

    // The snapshot landed in the artifacts drawer.
    const manifest = await svc.context.store.readProjectArtifact(
      projectId,
      review.manifestPath as string,
    );
    expect(manifest).toContain('"kind": "commit"');
    const diff = await svc.context.store.readProjectArtifact(projectId, review.diffPath as string);
    expect(diff).toContain('+changed line');

    // Same-kind concurrency guard: 409 carrying the live record.
    const dup = await call('POST', `/api/projects/${projectId}/git/reviews`, { kind: 'commit' });
    expect(dup.status).toBe(409);
    const dupBody = (await dup.json()) as { code: string; review: { id: string } };
    expect(dupBody.code).toBe('REVIEW_IN_PROGRESS');
    expect(dupBody.review.id).toBe(review.id);

    // List + read include the enriched task join.
    const listed = await call('GET', `/api/projects/${projectId}/git/reviews`);
    expect(listed.status).toBe(200);
    const { reviews } = (await listed.json()) as { reviews: Array<Record<string, unknown>> };
    expect(reviews.some((r) => r.id === review.id)).toBe(true);
    const read = await call('GET', `/api/projects/${projectId}/git/reviews/${review.id}`);
    expect(read.status).toBe(200);
    const missing = await call('GET', `/api/projects/${projectId}/git/reviews/nope`);
    expect(missing.status).toBe(404);

    // Cancel flows through the task and the settle hook flips the record.
    const canceled = await call(
      'POST',
      `/api/projects/${projectId}/git/reviews/${review.id}/cancel`,
    );
    expect(canceled.status).toBe(200);
    const cancelBody = (await canceled.json()) as { review: { status: string } };
    expect(cancelBody.review.status).toBe('canceled');
    const task = await svc.context.tasks.getByRef(review.taskRef as string);
    expect(task?.status).toBe('canceled');
  }, 60_000);

  it('rejects a branch review from the default branch with NOTHING_TO_REVIEW', async () => {
    if (!gitAvailable) return;
    const res = await call('POST', `/api/projects/${projectId}/git/reviews`, { kind: 'pr' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOTHING_TO_REVIEW');
  }, 30_000);

  it('requires a linked repo', async () => {
    const res = await call('POST', `/api/projects/${bareProjectId}/git/reviews`, {
      kind: 'commit',
    });
    expect(res.status).toBe(400);
  });

  it('serves git ops on both the canonical and legacy segments, reviews only on /git', async () => {
    if (!gitAvailable) return;
    const canonical = await call('GET', `/api/projects/${projectId}/git/status`);
    expect(canonical.status).toBe(200);
    const legacy = await call('GET', `/api/projects/${projectId}/github/status`);
    expect(legacy.status).toBe(200);
    const legacyReviews = await call('GET', `/api/projects/${projectId}/github/reviews`);
    expect(legacyReviews.status).toBe(404);
  });
});
