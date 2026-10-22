import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../fs/store.js';
import { toBoekwachterIssueWire } from '../../index-store/review-wire.js';
import type { ServiceContext } from '../context.js';
import { toolRoutes } from './tools.js';

const PROJECT = 'code';
const leads = [1, 2, 3].map((n) => ({
  severity: 'minor' as const,
  category: 'bug',
  message: `Lead number ${n} about the save loop.`,
}));

type Auth = { appId: string; scopes: string[]; gezelId?: string; projectId?: string | null };

describe('issue verdict routes', () => {
  let home: string;
  let store: Store;
  const log = vi.fn(async (_event: unknown) => {});

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-issue-verdict-routes-'));
    store = new Store({ home });
    await store.createProject({ name: 'Code' });
    await store.observeProjectBoekwachterReviews(PROJECT, [
      { path: 'src/save.ts', contentHash: 'h1', issues: leads },
    ]);
    log.mockClear();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function app(auth: Auth | undefined) {
    const ctx = {
      store,
      history: { log },
      contentIndex: {
        getBoekwachterIssue: async (id: string, ref: string) => {
          const record = await store.getProjectBoekwachterIssue(id, ref);
          return record ? toBoekwachterIssueWire(record, 'h1') : null;
        },
        updateBoekwachterIssue: async (id: string, ref: string, patch: object) => {
          const record = await store.updateProjectBoekwachterIssue(id, ref, patch);
          return record ? toBoekwachterIssueWire(record, 'h1') : null;
        },
      },
    } as unknown as ServiceContext;
    const root = new Hono();
    root.use('*', async (c, next) => {
      if (auth) c.set('auth', auth as never);
      await next();
    });
    root.route('/', toolRoutes(ctx));
    return root;
  }

  const post = (a: Hono, path: string, body: unknown) =>
    a.request(`/${PROJECT}/tools/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it("logs the person's dismissal from the issue row as a person's verdict", async () => {
    const res = await post(app({ appId: 'ui', scopes: ['ui'] }), 'update-file-issue', {
      ref: 'BW-1',
      status: 'dismissed',
      dismissalReason: 'not_an_issue',
      seen: true,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      issue: { status: 'dismissed', seen: true, latestVerdict: { by: { kind: 'person' } } },
    });
    const [entry] = await store.boekwachterIssues.readIssueVerdicts(PROJECT);
    expect(entry).toMatchObject({ kind: 'not_a_bug', by: { kind: 'person' } });
  });

  it("attributes a gezel's status change to that gezel", async () => {
    const auth = { appId: 'session:s1', scopes: ['session'], gezelId: 'bram' };
    const res = await post(app(auth), 'update-file-issue', { ref: 'BW-1', status: 'resolved' });
    expect(res.status).toBe(200);
    const [entry] = await store.boekwachterIssues.readIssueVerdicts(PROJECT);
    expect(entry).toMatchObject({ kind: 'fixed', by: { kind: 'gezel', gezelId: 'bram' } });
  });

  it('attributes a batch from an outside app to the app, never to a body field', async () => {
    const auth = {
      appId: `harness:claude-code:${PROJECT}`,
      scopes: ['harness'],
      projectId: PROJECT,
    };
    const res = await post(app(auth), 'issue-verdicts', {
      verdicts: [
        {
          ref: 'BW-1',
          kind: 'not_a_bug',
          reason: 'intended',
          note: 'Deliberate, see the comment above it.',
        },
        { ref: 'BW-2', kind: 'confirmed', note: 'Reproduced: the last row is dropped.' },
        { ref: 'BW-9', kind: 'nit' },
      ],
      by: { kind: 'person' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; refused: number };
    expect(body).toMatchObject({ applied: 2, refused: 1 });
    const entries = await store.boekwachterIssues.readIssueVerdicts(PROJECT);
    expect(entries.map((e) => e.by)).toEqual([
      { kind: 'app', client: 'claude-code' },
      { kind: 'app', client: 'claude-code' },
    ]);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      kind: 'project.issue.verdicts',
      details: { refs: ['BW-1', 'BW-2'], applied: 2, refused: 1 },
    });
  });

  it('holds outside apps to small batches', async () => {
    const auth = { appId: `harness:codex:${PROJECT}`, scopes: ['harness'], projectId: PROJECT };
    const verdicts = Array.from({ length: 26 }, () => ({ ref: 'BW-1', kind: 'unsure' }));
    const res = await post(app(auth), 'issue-verdicts', { verdicts });
    expect(res.status).toBe(400);
  });

  it('refuses a caller that is neither the person, a gezel nor an outside app', async () => {
    const res = await post(app({ appId: 'some-app', scopes: ['openai'] }), 'issue-verdicts', {
      verdicts: [{ ref: 'BW-1', kind: 'confirmed' }],
    });
    expect(res.status).toBe(403);
  });

  it('logs reopening by the person as an override', async () => {
    const person = app({ appId: 'ui', scopes: ['ui'] });
    await post(person, 'update-file-issue', { ref: 'BW-3', status: 'resolved' });
    const res = await post(person, 'update-file-issue', { ref: 'BW-3', status: 'open' });
    expect(res.status).toBe(200);
    const kinds = (await store.boekwachterIssues.readIssueVerdicts(PROJECT)).map((e) => e.kind);
    expect(kinds).toEqual(['fixed', 'reopened']);
  });

  describe('importing a filled-in handoff document', () => {
    const filled = [
      `<!-- gezel:issue-handoff project=${PROJECT} generated=2026-10-22T00:00:00.000Z -->`,
      '### BW-1 · minor · bug',
      '<!-- gezel:response BW-1 -->',
      'Verdict: not a bug',
      'Reason: handled elsewhere',
      'Notes: The caller checks the length.',
      '<!-- /gezel:response -->',
      '### BW-2 · minor · bug',
      '<!-- gezel:response BW-2 -->',
      'Verdict:',
      'Reason:',
      'Notes:',
      '<!-- /gezel:response -->',
    ].join('\n');

    it('records the answers as imported, never as the person', async () => {
      const res = await post(app({ appId: 'ui', scopes: ['ui'] }), 'issue-verdicts/import', {
        markdown: filled,
        declaredApp: 'ChatGPT',
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        applied: 1,
        refused: 0,
        skipped: ['BW-2'],
      });
      const [entry] = await store.boekwachterIssues.readIssueVerdicts(PROJECT);
      expect(entry).toMatchObject({
        kind: 'not_a_bug',
        reason: 'handled_elsewhere',
        by: { kind: 'import', declaredApp: 'ChatGPT' },
      });
    });

    it('refuses a document made for another project, and any caller but Gezel itself', async () => {
      const other = filled.replace(`project=${PROJECT}`, 'project=elsewhere');
      const person = app({ appId: 'ui', scopes: ['ui'] });
      expect((await post(person, 'issue-verdicts/import', { markdown: other })).status).toBe(409);
      const harnessApp = app({
        appId: `harness:claude-code:${PROJECT}`,
        scopes: ['harness'],
        projectId: PROJECT,
      });
      expect((await post(harnessApp, 'issue-verdicts/import', { markdown: filled })).status).toBe(
        403,
      );
      expect(await store.boekwachterIssues.readIssueVerdicts(PROJECT)).toEqual([]);
    });
  });
});
