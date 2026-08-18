import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEZEL_VERSION, resolveShowWorkInProgressFeatures } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from './service.js';

vi.mock('./memory/embeddings.js', () => {
  const vectorFor = (text: string): number[] => {
    const vector = new Array<number>(16).fill(0);
    for (let i = 0; i < text.length; i++) {
      vector[i % vector.length]! += text.charCodeAt(i) / 255;
    }
    const magnitude = Math.hypot(...vector) || 1;
    return vector.map((v) => v / magnitude);
  };

  class EmbeddingsDisabledError extends Error {
    readonly code = 'EMBEDDINGS_DISABLED';
  }

  return {
    EmbeddingsDisabledError,
    embeddingsDisabledReason: () => null,
    embed: async (text: string) => vectorFor(text),
    embedQuery: async (text: string) => vectorFor(text),
    embedBatch: async (texts: string[]) => texts.map(vectorFor),
  };
});

let svc: RunningService;
let baseUrl: string;
let token: string;
let httpFetch: typeof fetch;

// Mock-provider mode disables both the real-LLM path AND the
// fire-and-forget first-run install kicked off in `service.ts`.
// Without this, a Hugging Face download starts in the background,
// outlives the test, and crashes with ENOENT when `afterAll` rm's
// the tmpdir. None of the assertions in this file need a real
// provider — they exercise CRUD/HTTP routes only.
beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const home = await mkdtemp(join(tmpdir(), 'lv-integ-'));
  svc = await startService({ home });
  // Daemon now defaults to HTTPS; switch the test client to a trusting
  // fetch built from the cert it generated. Falls back to plain `fetch`
  // when running with `GEZEL_INSECURE_TRANSPORT=1`.
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(svc.context.home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

function api(method: string, path: string, body?: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('health', () => {
  it('returns ok without auth', async () => {
    const res = await httpFetch(`${baseUrl}/api/health`);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.version).toBeDefined();
    expect(res.headers.get('cross-origin-opener-policy')).toBeNull();
    expect(res.headers.get('cross-origin-embedder-policy')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-security-policy')).not.toContain("'wasm-unsafe-eval'");
  });
});

describe('operational API surface', () => {
  it.each([
    ['/api/usage', 'providers'],
    ['/api/queues', 'providers'],
    ['/api/channels', 'channels'],
    ['/api/remotes', 'remotes'],
  ])('serves %s with its stable top-level envelope', async (path, envelopeKey) => {
    const res = await api('GET', path);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty(envelopeKey);
  });

  it('keeps control-plane routes behind bearer authentication', async () => {
    const res = await httpFetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(401);
  });

  it('round-trips durable document export preferences', async () => {
    const documentExportOptions = {
      format: 'docx',
      themeId: 'standard',
      transformStyle: 'documentary',
      pageSize: 'a4',
      htmlStyle: 'plain',
      htmlBundle: 'single',
    };
    const update = await api('PUT', '/api/config', { documentExportOptions });
    expect(update.status).toBe(200);
    expect((await update.json()) as Record<string, unknown>).toMatchObject({
      documentExportOptions,
    });

    const read = await api('GET', '/api/config');
    expect(read.status).toBe(200);
    expect((await read.json()) as Record<string, unknown>).toMatchObject({
      documentExportOptions,
    });
  });

  it('round-trips Codex CLI reasoning effort through PUT and GET', async () => {
    // Regression: both config responses are hand-picked whitelists. The
    // setting was persisted, but its omission from those responses made the
    // controlled picker immediately jump back to the model default.
    const codexCli = {
      defaultReasoningEffort: 'ultra' as const,
      defaultPermissionMode: 'acceptEdits' as const,
    };
    const resetClient = vi.spyOn(svc.context.chat, 'resetClient');

    try {
      const update = await api('PUT', '/api/config', { codexCli });
      expect(update.status).toBe(200);
      expect((await update.json()) as Record<string, unknown>).toMatchObject({ codexCli });
      // CodexCliProvider snapshots this setting at construction, so the
      // update must evict cached clients rather than waiting for a restart.
      expect(resetClient).toHaveBeenCalled();

      const read = await api('GET', '/api/config');
      expect(read.status).toBe(200);
      expect((await read.json()) as Record<string, unknown>).toMatchObject({ codexCli });
    } finally {
      resetClient.mockRestore();
    }
  });

  it('round-trips llama-cpp Advanced overrides through PUT and GET, and clears on null', async () => {
    // Regression: the GET/PUT config responses hand-pick a whitelist of
    // fields. These llama-cpp Advanced knobs were written to disk but
    // absent from both responses, so the Settings UI's optimistic
    // setConfig(next) reverted the dropdowns to their defaults the instant
    // the user changed them — they "didn't seem to change."
    const overrides = {
      llamaCppKvCacheType: 'f16',
      llamaCppFlashAttn: 'on',
      llamaCppSpecType: 'ngram-simple',
      llamaCppCpuMoe: true,
      llamaCppSwaFull: true,
    };
    const update = await api('PUT', '/api/config', overrides);
    expect(update.status).toBe(200);
    expect((await update.json()) as Record<string, unknown>).toMatchObject(overrides);

    const read = await api('GET', '/api/config');
    expect((await read.json()) as Record<string, unknown>).toMatchObject(overrides);

    // Selecting the default sentinel sends null, which the store treats as
    // "reset to default" (undefined would be stripped by JSON.stringify and
    // never clear the pinned value).
    const cleared = await api('PUT', '/api/config', {
      llamaCppKvCacheType: null,
      llamaCppFlashAttn: null,
      llamaCppSpecType: null,
      llamaCppCpuMoe: null,
      llamaCppSwaFull: null,
    });
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as Record<string, unknown>;
    expect(clearedBody.llamaCppKvCacheType).toBeUndefined();
    expect(clearedBody.llamaCppFlashAttn).toBeUndefined();
    expect(clearedBody.llamaCppSpecType).toBeUndefined();
    expect(clearedBody.llamaCppCpuMoe).toBeUndefined();
    expect(clearedBody.llamaCppSwaFull).toBeUndefined();
  });

  it('round-trips MLX Advanced overrides through PUT and GET, and clears on null', async () => {
    // Same echo-bug class as the llama-cpp fields: mlxPackageSpec and
    // mlxKvBits were written to disk but absent from both responses.
    const overrides = { mlxPackageSpec: 'mlx-lm==0.25.3', mlxKvBits: 8 };
    const update = await api('PUT', '/api/config', overrides);
    expect(update.status).toBe(200);
    expect((await update.json()) as Record<string, unknown>).toMatchObject(overrides);

    const read = await api('GET', '/api/config');
    expect((await read.json()) as Record<string, unknown>).toMatchObject(overrides);

    const cleared = await api('PUT', '/api/config', {
      mlxPackageSpec: null,
      mlxKvBits: null,
    });
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as Record<string, unknown>;
    expect(clearedBody.mlxPackageSpec).toBeUndefined();
    expect(clearedBody.mlxKvBits).toBeUndefined();
  });
});

describe('gezels API', () => {
  it('creates, lists, gets, and renames a gezel', async () => {
    const createRes = await api('POST', '/api/gezels', { name: 'TestBot' });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string; about: string };
    expect(created.id).toBe('testbot');
    expect(created.about).toBeTruthy();

    const listRes = await api('GET', '/api/gezels');
    const list = (await listRes.json()) as { gezels: Array<{ id: string }> };
    expect(list.gezels.find((a) => a.id === 'testbot')).toBeTruthy();

    const getRes = await api('GET', '/api/gezels/testbot');
    expect(getRes.status).toBe(200);

    const renameRes = await api('POST', '/api/gezels/testbot/rename', { name: 'BetterBot' });
    expect(renameRes.status).toBe(200);
    const renamed = (await renameRes.json()) as { id: string; name: string };
    expect(renamed.name).toBe('BetterBot');
  });

  it('returns 404 for missing gezel', async () => {
    const res = await api('GET', '/api/gezels/nope');
    expect(res.status).toBe(404);
  });

  it('announces a gezel recruited through ensure_gezel on the global stream', async () => {
    const lifecycle: Array<{ event: { type: string; gezelId?: string; name?: string } }> = [];
    const unsubscribe = svc.context.chatEvents.subscribeAll((event) => lifecycle.push(event));
    try {
      const res = await api('POST', '/api/gezels/ensure', { jobTitle: 'Software Developer' });
      expect(res.status).toBe(200);
      const recruited = (await res.json()) as {
        gezelId: string;
        name: string;
        action: string;
      };
      expect(recruited.action).not.toBe('reused');
      expect(
        lifecycle.some(
          (envelope) =>
            envelope.event.type === 'gezel_created' &&
            envelope.event.gezelId === recruited.gezelId &&
            envelope.event.name === recruited.name,
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});

describe('projects API', () => {
  it('default project exists from boot', async () => {
    const res = await api('GET', '/api/projects');
    const data = (await res.json()) as { projects: Array<{ id: string }> };
    expect(data.projects.find((p) => p.id === 'default')).toBeTruthy();
  });

  it('boots the shared library project onto the documents root', async () => {
    const res = await api('GET', '/api/projects');
    const data = (await res.json()) as {
      projects: Array<{
        id: string;
        workingDir?: string;
        properties?: Record<string, string>;
        voormanAutoAssignedAt?: string;
        managedWorkspaceWritePolicy?: string;
      }>;
    };
    const shared = data.projects.find((p) => p.properties?.['gezel.sharedLibrary'] === '1');
    expect(shared).toBeTruthy();
    // Its workspace IS the library, which is what earns it every
    // per-project service without a second pipeline.
    expect(shared?.workingDir).toContain('documents');
    // Written through the document tools, so the external-workingDir gate
    // must admit them; and no lead is recruited for a document shelf.
    expect(shared?.managedWorkspaceWritePolicy).toBe('allow');
    expect(shared?.voormanAutoAssignedAt).toBeTruthy();

    // The starter document is what a first-run user opens.
    const docs = await api('GET', '/api/documents');
    const listing = (await docs.json()) as { files: Array<{ path: string }> };
    expect(listing.files.some((f) => f.path.startsWith('About this library'))).toBe(true);

    // The Boekwachter is the library's resident gezel — and its presence on
    // the roster is what opts the library into the AI enrichment tier.
    const roster = await api('GET', `/api/projects/${shared?.id}/gezels`);
    const crew = (await roster.json()) as { gezelIds: string[] };
    const cfgRes = await api('GET', '/api/config');
    const cfg = (await cfgRes.json()) as { boekwachterGezelId?: string };
    expect(cfg.boekwachterGezelId).toBeTruthy();
    expect(crew.gezelIds).toContain(cfg.boekwachterGezelId);
  });

  it('creates a project and manages artifacts', async () => {
    await api('POST', '/api/projects', {
      name: 'IntegTest',
      about:
        'A project used by the integration test suite to exercise artifact storage and lookup.',
      missionObjectives: 'Artifact write/read/list/delete HTTP paths all work.',
    });

    await api('PUT', '/api/projects/integtest/artifacts/write', {
      path: 'notes.md',
      content: '# Notes\n\nHello.',
    });

    const readRes = await api('GET', '/api/projects/integtest/artifacts/read?path=notes.md');
    const file = (await readRes.json()) as { content: string; size?: number };
    expect(file.content).toContain('# Notes');
    // Byte size rides along so the viewer can describe files it cannot preview.
    expect(file.size).toBe(Buffer.byteLength('# Notes\n\nHello.'));

    const listRes = await api('GET', '/api/projects/integtest/artifacts?recursive=1');
    const files = (await listRes.json()) as { files: Array<{ name: string }> };
    expect(files.files.find((f) => f.name === 'notes.md')).toBeTruthy();

    const locationRes = await api(
      'GET',
      '/api/projects/integtest/reference-file-location?kind=artifact&path=notes.md',
    );
    expect(locationRes.status).toBe(200);
    const location = (await locationRes.json()) as { path: string };
    expect(location.path).toBe(
      await realpath(join(svc.context.home, 'projects', 'integtest', 'artifacts', 'notes.md')),
    );

    const unsafeRevealRes = await api(
      'POST',
      '/api/projects/integtest/reveal-reference?kind=artifact&path=..%2Foutside.md',
    );
    expect(unsafeRevealRes.status).toBe(400);

    const delRes = await api('DELETE', '/api/projects/integtest/artifacts/delete?path=notes.md');
    expect(delRes.status).toBe(200);
  });

  it('sets and reads working directory', async () => {
    await api('POST', '/api/projects', {
      name: 'WdTest',
      about:
        'Integration test project for the working-directory endpoint — sets and reads back a workingDir.',
      missionObjectives: 'PUT /working-dir and GET project return matching values.',
    });
    await api('PUT', '/api/projects/wdtest/working-dir', { workingDir: '/tmp' });
    const res = await api('GET', '/api/projects/wdtest');
    const proj = (await res.json()) as { workingDir: string };
    expect(proj.workingDir).toBe('/tmp');
  });

  it('rebuilds project tool surfaces when its edit permission changes', async () => {
    const create = await api('POST', '/api/projects', {
      name: 'PermissionRefresh',
      about: 'A project used to verify live permission-surface refreshes.',
      missionObjectives: 'Permission changes rebuild cached project tool surfaces.',
    });
    expect(create.status).toBe(201);
    const projectId = ((await create.json()) as { id: string }).id;
    const resetProjectToolsets = vi.spyOn(svc.context.chat, 'resetProjectToolsets');
    try {
      const res = await api('PUT', `/api/projects/${projectId}`, {
        managedWorkspaceWritePolicy: 'allow',
        codexPermissionMode: 'edit',
        claudePermissionMode: 'acceptEdits',
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        managedWorkspaceWritePolicy: 'allow',
        codexPermissionMode: 'edit',
        claudePermissionMode: 'acceptEdits',
      });
      expect(resetProjectToolsets).toHaveBeenCalledWith(projectId);
    } finally {
      resetProjectToolsets.mockRestore();
    }
  });

  it('creates typed projects atomically and emits no lifecycle/history event on failure', async () => {
    const lifecycle: Array<{ event: { type: string; projectId?: string } }> = [];
    const unsubscribe = svc.context.chatEvents.subscribeAll((event) => lifecycle.push(event));
    try {
      const failed = await api('POST', '/api/projects/typed', {
        name: 'AtomicFailure',
        projectType: { typeId: '__missing_project_type__' },
      });
      expect(failed.status).toBe(400);
      expect((await failed.json()) as { code?: string }).toMatchObject({
        code: 'PROJECT_TYPE_INVALID',
      });
      expect(await svc.context.store.getProject('atomicfailure')).toBeNull();
      expect(
        lifecycle.some(
          (envelope) =>
            envelope.event.type === 'project_created' &&
            envelope.event.projectId === 'atomicfailure',
        ),
      ).toBe(false);
      expect(
        await svc.context.history.listEvents({
          projectId: 'atomicfailure',
          kinds: ['project.created'],
        }),
      ).toEqual([]);

      const success = await api('POST', '/api/projects/typed', {
        name: 'AtomicEmailType',
        projectType: { typeId: 'email' },
      });
      expect(success.status).toBe(201);
      const body = (await success.json()) as {
        project: { id: string; projectType?: { id: string }; about?: string };
        applied: { typeId: string };
      };
      expect(body.project.id).toBe('atomicemailtype');
      expect(body.project.projectType?.id).toBe('email');
      expect(body.applied.typeId).toBe('email');
      expect(
        lifecycle.some(
          (envelope) =>
            envelope.event.type === 'project_created' &&
            envelope.event.projectId === body.project.id,
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});

describe('tasks API', () => {
  it('creates, advances, and lists tasks via HTTP', async () => {
    await api('POST', '/api/gezels', { name: 'TaskAgent' });
    await api('POST', '/api/projects', {
      name: 'TaskProj',
      about:
        'Integration test project that exercises the task-creation, advance, and list HTTP routes end-to-end.',
      missionObjectives: 'Task CRUD + step advance works via the HTTP API.',
    });

    const createRes = await api('POST', '/api/projects/taskproj/tasks', {
      title: 'Ship the thing',
      description:
        'Verify the HTTP task API round-trips a multi-step task so the integration test covers it.',
      assignee: { kind: 'gezel', gezelId: 'taskagent' },
      steps: [{ name: 'Design' }, { name: 'Build' }, { name: 'Ship' }],
    });
    expect(createRes.status).toBe(201);
    const task = (await createRes.json()) as {
      ref: string;
      num: number;
      activeStepId: string;
      craftbook: { steps: Array<{ id: string; name: string }> };
    };
    expect(task.ref).toBe('taskproj/1');
    expect(task.craftbook.steps).toHaveLength(3);
    expect(task.activeStepId).toBe(task.craftbook.steps[0]!.id);

    // Status update.
    const statusRes = await api('POST', '/api/projects/taskproj/tasks/1/status', {
      status: 'paused',
    });
    const paused = (await statusRes.json()) as { status: string };
    expect(paused.status).toBe('paused');

    // Complete step 1 → next step activates.
    const firstId = task.craftbook.steps[0]!.id;
    const advRes = await api(
      'POST',
      `/api/projects/taskproj/tasks/1/steps/${firstId}/complete`,
      {},
    );
    // The route returns { task, gate? } — a gate rejection is a
    // structured result, not a different status code.
    const { task: advanced, gate } = (await advRes.json()) as {
      task: {
        activeStepId: string;
        craftbook: { steps: Array<{ id: string; completedAt?: string }> };
      };
      gate?: unknown;
    };
    expect(gate).toBeUndefined();
    expect(advanced.activeStepId).toBe(task.craftbook.steps[1]!.id);
    expect(advanced.craftbook.steps[0]!.completedAt).toBeTruthy();

    // Global and per-project listing both find it.
    const listGlobal = (await (await api('GET', '/api/tasks')).json()) as {
      tasks: Array<{ ref: string }>;
    };
    expect(listGlobal.tasks.some((t) => t.ref === 'taskproj/1')).toBe(true);
    const listProject = (await (await api('GET', '/api/projects/taskproj/tasks')).json()) as {
      tasks: Array<{ ref: string }>;
    };
    expect(listProject.tasks).toHaveLength(1);
  });

  it('clears a task description durably through PATCH', async () => {
    await api('POST', '/api/projects', {
      name: 'TaskClearProj',
      about:
        'Integration test project for verifying task description sidecars are removed on clear.',
      missionObjectives: 'PATCH an empty task description and verify it stays absent after reload.',
    });
    const createRes = await api('POST', '/api/projects/taskclearproj/tasks', {
      title: 'Clear the description',
      description: 'This description is deliberately longer than forty characters for creation.',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main', terminal: true }],
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { num: number };

    const patchRes = await api('PATCH', `/api/projects/taskclearproj/tasks/${created.num}`, {
      description: '',
    });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { description?: string }).description).toBeUndefined();

    const reloadRes = await api('GET', `/api/projects/taskclearproj/tasks/${created.num}`);
    expect(reloadRes.status).toBe(200);
    expect(((await reloadRes.json()) as { description?: string }).description).toBeUndefined();
    expect(await svc.context.store.readTaskAbout('taskclearproj', created.num)).toBe('');
  });

  it('dispatchEntry: true enqueues the entry handoff and logs task.entry.dispatched', async () => {
    await api('POST', '/api/gezels', { name: 'KickAgent' });
    await api('POST', '/api/projects', {
      name: 'KickProj',
      about:
        'Integration test project for the single-channel kickoff flag on the task-create route.',
      missionObjectives: 'dispatchEntry hands the entry step to its gezel at create.',
    });

    const createRes = await api('POST', '/api/projects/kickproj/tasks', {
      title: 'Kickoff test',
      description:
        'Verify dispatchEntry enqueues a task-scoped entry handoff instead of a chat notification.',
      assignee: { kind: 'gezel', gezelId: 'kickagent' },
      steps: [{ name: 'Build' }, { name: 'Ship' }],
      dispatchEntry: true,
    });
    expect(createRes.status).toBe(201);
    const task = (await createRes.json()) as { ref: string; activeStepId: string };
    expect(task.ref).toBe('kickproj/1');

    // The dispatch event is written synchronously at enqueue — no
    // runner-tick wait needed over HTTP.
    const history = (await (
      await api('GET', '/api/history?kind=task.entry.dispatched&project=kickproj')
    ).json()) as { entries?: Array<{ kind: string; details?: Record<string, unknown> }> };
    const entries = history.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.details).toMatchObject({
      ref: 'kickproj/1',
      stepId: task.activeStepId,
      gezelId: 'kickagent',
    });
  });
});

describe('memory API', () => {
  it('saves and retrieves memories', async () => {
    await api('POST', '/api/gezels', { name: 'MemAgent' });

    const saveRes = await api('POST', '/api/memory/save', {
      scope: 'gezel',
      id: 'memagent',
      text: 'User prefers concise answers.',
    });
    // Catches the previous "vector index never worked" bug: save used to
    // return 200 because the markdown write succeeds before the broken
    // vector write throws. Now save() must succeed end-to-end.
    expect(saveRes.status).toBe(200);

    const recentRes = await api('GET', '/api/memory/recent?scope=gezel&id=memagent&days=1');
    const recent = (await recentRes.json()) as { content: string };
    expect(recent.content).toContain('concise answers');

    // Round-trip via the vector index — this would have hung / 500'd before
    // the LocalIndex constructor bug fix because every queryItems threw
    // "Index does not exist".
    const searchRes = await api('POST', '/api/memory/search', {
      gezelId: 'memagent',
      projectId: 'default',
      query: 'concise',
      topK: 5,
    });
    expect(searchRes.status).toBe(200);
    const search = (await searchRes.json()) as {
      results: Array<{ text: string; score: number }>;
    };
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.some((r) => r.text.includes('concise answers'))).toBe(true);
  });

  it('edits a project memory day and refreshes its derived index', async () => {
    await api('POST', '/api/projects', { name: 'Memory Project' });
    await api('POST', '/api/gezels', { name: 'Memory Searcher' });
    const saveRes = await api('POST', '/api/memory/save', {
      scope: 'project',
      id: 'memory-project',
      text: 'The original project decision.',
      kind: 'decision',
    });
    expect(saveRes.status).toBe(200);

    const daysRes = await api('GET', '/api/memory/days?scope=project&id=memory-project');
    const { days } = (await daysRes.json()) as { days: string[] };
    expect(days).toHaveLength(1);
    const day = days[0]!;

    const updateRes = await api(
      'PATCH',
      `/api/memory/day?scope=project&id=memory-project&day=${day}`,
      { content: '## 11:20 [decision]\n\nThe edited project decision.\n' },
    );
    expect(updateRes.status).toBe(200);
    expect(await updateRes.json()).toEqual({ ok: true, indexed: true });

    const readRes = await api('GET', `/api/memory/day?scope=project&id=memory-project&day=${day}`);
    expect(await readRes.json()).toEqual({
      content: '## 11:20 [decision]\n\nThe edited project decision.\n',
    });

    const searchRes = await api('POST', '/api/memory/search', {
      gezelId: 'memory-searcher',
      projectId: 'memory-project',
      query: 'edited project decision',
      topK: 5,
    });
    const search = (await searchRes.json()) as { results: Array<{ text: string }> };
    expect(search.results.some((result) => result.text === 'The edited project decision.')).toBe(
      true,
    );

    const invalidDay = await api(
      'PATCH',
      '/api/memory/day?scope=project&id=memory-project&day=../config',
      { content: 'nope' },
    );
    expect(invalidDay.status).toBe(400);

    const invalidId = await api('PATCH', '/api/memory/day?scope=project&id=..&day=2026-08-04', {
      content: 'nope',
    });
    expect(invalidId.status).toBe(400);
  });
});

describe('config API', () => {
  it('gets and sets config', async () => {
    const getRes = await api('GET', '/api/config');
    const initial = (await getRes.json()) as { hasGithubToken: boolean };
    expect(initial.hasGithubToken).toBe(false);

    await api('PUT', '/api/config', { githubToken: 'ghp_test' });
    const updated = (await api('GET', '/api/config')).json() as Promise<{
      hasGithubToken: boolean;
    }>;
    expect((await updated).hasGithubToken).toBe(true);
  });

  it('echoes the startup template reset setting after updates', async () => {
    const enabledRes = await api('PUT', '/api/config', { resetTemplatesOnStartup: true });
    expect(enabledRes.status).toBe(200);
    expect(await enabledRes.json()).toMatchObject({ resetTemplatesOnStartup: true });

    const persistedRes = await api('GET', '/api/config');
    expect(await persistedRes.json()).toMatchObject({ resetTemplatesOnStartup: true });

    const disabledRes = await api('PUT', '/api/config', { resetTemplatesOnStartup: false });
    expect(disabledRes.status).toBe(200);
    expect(await disabledRes.json()).toMatchObject({ resetTemplatesOnStartup: false });
  });

  it('materializes and persists the automatic update-check preference', async () => {
    const initialRes = await api('GET', '/api/config');
    expect(await initialRes.json()).toMatchObject({ autoUpdateChecks: true });

    const disabledRes = await api('PUT', '/api/config', { autoUpdateChecks: false });
    expect(disabledRes.status).toBe(200);
    expect(await disabledRes.json()).toMatchObject({ autoUpdateChecks: false });

    const persistedRes = await api('GET', '/api/config');
    expect(await persistedRes.json()).toMatchObject({ autoUpdateChecks: false });
  });

  it('materializes the build default for work-in-progress features and persists explicit choices', async () => {
    const initialRes = await api('GET', '/api/config');
    expect(await initialRes.json()).toMatchObject({
      showWorkInProgressFeatures: resolveShowWorkInProgressFeatures(undefined, GEZEL_VERSION),
    });

    const disabledRes = await api('PUT', '/api/config', { showWorkInProgressFeatures: false });
    expect(disabledRes.status).toBe(200);
    expect(await disabledRes.json()).toMatchObject({ showWorkInProgressFeatures: false });

    const disabledPersistedRes = await api('GET', '/api/config');
    expect(await disabledPersistedRes.json()).toMatchObject({ showWorkInProgressFeatures: false });

    const enabledRes = await api('PUT', '/api/config', { showWorkInProgressFeatures: true });
    expect(enabledRes.status).toBe(200);
    expect(await enabledRes.json()).toMatchObject({ showWorkInProgressFeatures: true });

    const persistedRes = await api('GET', '/api/config');
    expect(await persistedRes.json()).toMatchObject({ showWorkInProgressFeatures: true });
  });
});

describe('auth', () => {
  it('rejects unauthenticated API requests', async () => {
    const res = await httpFetch(`${baseUrl}/api/gezels`);
    expect(res.status).toBe(401);
  });

  it('serves UI without auth', async () => {
    const res = await httpFetch(`${baseUrl}/`);
    // Either HTML (if UI bundle found) or a fallback page
    expect(res.status).toBe(200);
  });
});
