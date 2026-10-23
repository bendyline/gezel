import type { GezelConfig, HarnessToolsConfig } from '@bendyline/gezel';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { VERDICTS_PER_HOUR, harnessRouteGuard } from './harness-route-guard.js';

const PROJECT = 'repo';

function stack(opts: { projectId?: string | null; harnessTools?: HarnessToolsConfig } = {}) {
  const projectId = opts.projectId === undefined ? PROJECT : opts.projectId;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      appId: `harness:claude-code:${projectId ?? 'none'}`,
      appName: 'Claude Code',
      scopes: ['harness'],
      ...(projectId ? { projectId } : {}),
    } as never);
    await next();
  });
  const guard = harnessRouteGuard({
    readConfig: async () =>
      ({ ...(opts.harnessTools ? { harnessTools: opts.harnessTools } : {}) }) as GezelConfig,
  });
  app.use('/api/*', guard);
  app.use('/events/*', guard);
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('harnessRouteGuard', () => {
  it('admits search of the bound project over the corpora it may name', async () => {
    const res = await stack().request(
      `/api/projects/${PROJECT}/tools/search`,
      post({ query: 'x', sources: ['workspace', 'shared', 'knowledge', 'project-memory'] }),
    );
    expect(res.status).toBe(200);
  });

  it('refuses search that omits sources, names a gezel, or reaches private memory', async () => {
    const app = stack();
    const path = `/api/projects/${PROJECT}/tools/search`;
    for (const body of [
      { query: 'x' },
      { query: 'x', sources: [] },
      { query: 'x', sources: ['workspace'], gezelId: 'g1' },
      { query: 'x', sources: ['gezel-memory'] },
    ]) {
      expect((await app.request(path, post(body))).status, JSON.stringify(body)).toBe(403);
    }
  });

  it('drops memory corpora from search when memory is off', async () => {
    const app = stack({ harnessTools: { memory: 'off' } });
    const path = `/api/projects/${PROJECT}/tools/search`;
    expect((await app.request(path, post({ query: 'x', sources: ['user-memory'] }))).status).toBe(
      403,
    );
    expect((await app.request(path, post({ query: 'x', sources: ['workspace'] }))).status).toBe(
      200,
    );
  });

  it('confines project routes to the bound project and its few read routes', async () => {
    const app = stack();
    expect((await app.request(`/api/projects/${PROJECT}`)).status).toBe(200);
    expect((await app.request(`/api/projects/${PROJECT}/index/status`)).status).toBe(200);
    expect(
      (
        await app.request(
          `/api/projects/${PROJECT}/tools/read-doc-as-markdown`,
          post({ path: 'a.docx' }),
        )
      ).status,
    ).toBe(200);
    for (const [path, init] of [
      ['/api/projects/other', undefined],
      ['/api/projects/other/tools/search', post({ query: 'x', sources: ['workspace'] })],
      [`/api/projects/${PROJECT}/workspace/file?path=a.txt`, undefined],
      [`/api/projects/${PROJECT}/tasks`, undefined],
      [`/api/projects/${PROJECT}/tools/grep-files`, post({ pattern: 'x' })],
      ['/api/projects', undefined],
    ] as const) {
      expect((await app.request(path, init)).status, path).toBe(403);
    }
  });

  it('never opens the event stream, config, gezels, sessions or library writes', async () => {
    const app = stack();
    for (const [path, init] of [
      ['/events/chat', undefined],
      ['/api/config', { method: 'PUT', body: '{}' }],
      ['/api/gezels', undefined],
      ['/api/sessions', undefined],
      ['/api/documents/write', { method: 'PUT', body: '{}' }],
      ['/api/documents/reveal', post({})],
      ['/api/documents/read?path=projects/repo/secret.md', undefined],
      ['/api/knowledge/catalogs/x/install', post({})],
    ] as const) {
      expect((await app.request(path, init)).status, path).toBe(403);
    }
  });

  it('never opens Gezel’s own Handboek to an outside app', async () => {
    const app = stack();
    for (const path of [
      '/api/knowledge/catalogs/handboek/document?id=x',
      '/api/knowledge/catalogs/handboek/passage?id=x&chunk=y',
    ]) {
      expect((await app.request(path)).status, path).toBe(403);
    }
  });

  it('admits shared library and knowledge reads', async () => {
    const app = stack();
    for (const path of [
      '/api/documents',
      '/api/documents/search?q=mission',
      '/api/documents/read?path=mission.md',
      '/api/knowledge/catalogs',
      '/api/knowledge/catalogs/wiki/document?uri=x',
    ]) {
      expect((await app.request(path)).status, path).toBe(200);
    }
  });

  it('hands over issues and takes verdicts as the Issues setting allows', async () => {
    const handoff = (harnessTools?: HarnessToolsConfig) =>
      stack(harnessTools ? { harnessTools } : {}).request(
        `/api/projects/${PROJECT}/tools/issue-handoff`,
        post({}),
      );
    const verdicts = (body: unknown, harnessTools?: HarnessToolsConfig) =>
      stack(harnessTools ? { harnessTools } : {}).request(
        `/api/projects/${PROJECT}/tools/issue-verdicts`,
        post(body),
      );
    const one = { verdicts: [{ ref: 'BW-1', kind: 'confirmed' }] };
    expect((await handoff()).status).toBe(200);
    expect((await verdicts(one)).status).toBe(200);
    expect((await handoff({ issues: 'read' })).status).toBe(200);
    expect((await verdicts(one, { issues: 'read' })).status).toBe(403);
    expect((await handoff({ issues: 'off' })).status).toBe(403);
    expect((await verdicts({ ...one, by: { kind: 'person' } })).status).toBe(403);
  });

  it('never lets an app import a handoff document or reach another project issues', async () => {
    const app = stack();
    expect(
      (
        await app.request(
          `/api/projects/${PROJECT}/tools/issue-verdicts/import`,
          post({ markdown: 'x' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await app.request('/api/projects/other/tools/issue-verdicts', post({ verdicts: [] })))
        .status,
    ).toBe(403);
    expect(
      (
        await stack({ projectId: null }).request(
          `/api/projects/${PROJECT}/tools/issue-handoff`,
          post({}),
        )
      ).status,
    ).toBe(403);
  });

  it('stops an app that reports too many verdicts in an hour', async () => {
    const app = stack();
    const batch = { verdicts: Array.from({ length: 25 }, () => ({ ref: 'BW-1', kind: 'nit' })) };
    const send = () => app.request(`/api/projects/${PROJECT}/tools/issue-verdicts`, post(batch));
    for (let i = 0; i < VERDICTS_PER_HOUR / 25; i++) expect((await send()).status).toBe(200);
    const res = await send();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ hint: expect.stringMatching(/last hour/) });
  });

  it('saves memories only to the bound project, and only when saving is on', async () => {
    const save = (body: unknown, harnessTools?: HarnessToolsConfig) =>
      stack(harnessTools ? { harnessTools } : {}).request('/api/memory/save', post(body));
    expect((await save({ scope: 'project', id: PROJECT, text: 'x' })).status).toBe(200);
    expect((await save({ scope: 'user', id: 'user', text: 'x' })).status).toBe(403);
    expect((await save({ scope: 'project', id: 'other', text: 'x' })).status).toBe(403);
    expect((await save({ scope: 'gezel', id: 'g1', text: 'x' })).status).toBe(403);
    expect(
      (await save({ scope: 'project', id: PROJECT, text: 'x' }, { memory: 'read' })).status,
    ).toBe(403);
  });

  it('admits image generation for the bound project as no gezel, never into the folder', async () => {
    const app = stack();
    const gen = (body: unknown) => app.request('/api/image-gen/generate', post(body));
    expect((await gen({ prompt: 'a cat', projectId: PROJECT })).status).toBe(200);
    expect((await gen({ prompt: 'a cat' })).status).toBe(403);
    expect((await gen({ prompt: 'a cat', projectId: PROJECT, saveAs: 'logo.png' })).status).toBe(
      403,
    );
    expect(
      (await gen({ prompt: 'a cat', projectId: PROJECT, gezelId: 'g', sessionId: 's' })).status,
    ).toBe(403);
    const off = stack({ harnessTools: { images: 'off' } });
    expect(
      (await off.request('/api/image-gen/generate', post({ prompt: 'x', projectId: PROJECT })))
        .status,
    ).toBe(403);
  });

  it('binds image description to the project through its query', async () => {
    const app = stack();
    const describeIn = (qs: string) =>
      app.request(`/api/recognition/describe${qs}`, post({ data: 'AA==' }));
    expect((await describeIn(`?project=${PROJECT}`)).status).toBe(200);
    expect((await describeIn('?project=other')).status).toBe(403);
    expect((await describeIn('')).status).toBe(403);
  });

  it('gives an app bound to no project the library and knowledge, not a folder', async () => {
    const app = stack({ projectId: null });
    const search = (sources: string[]) =>
      app.request('/api/projects/default/tools/search', post({ query: 'x', sources }));
    expect((await search(['shared', 'knowledge', 'user-memory'])).status).toBe(200);
    expect((await search(['workspace'])).status).toBe(403);
    expect((await search(['project-memory'])).status).toBe(403);
    expect((await app.request('/api/projects/default')).status).toBe(403);
    expect(
      (await app.request('/api/memory/save', post({ scope: 'project', id: 'default', text: 'x' })))
        .status,
    ).toBe(403);
    expect(
      (
        await app.request(
          '/api/recognition/describe?project=default',
          post({ artifactPath: 'generated/a.png' }),
        )
      ).status,
    ).toBe(403);
  });

  it('refuses everything once the person turns the tools off or stops this app', async () => {
    const off = await stack({ harnessTools: { enabled: false } }).request('/api/documents');
    expect(off.status).toBe(403);
    expect(((await off.json()) as { error: string }).error).toBe('harness_tools_off');
    const stopped = await stack({
      harnessTools: { blocked: [{ client: 'claude-code', projectId: PROJECT }] },
    }).request('/api/documents');
    expect(stopped.status).toBe(403);
    expect(((await stopped.json()) as { error: string }).error).toBe('harness_disconnected');
  });

  it('leaves every other principal to the guards after it', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { appId: 'desktop-client', appName: 'Gezel', scopes: ['ui'] } as never);
      await next();
    });
    app.use('/api/*', harnessRouteGuard({ readConfig: async () => ({}) as GezelConfig }));
    app.all('*', (c) => c.json({ ok: true }));
    expect((await app.request('/api/config', { method: 'PUT', body: '{}' })).status).toBe(200);
  });
});
