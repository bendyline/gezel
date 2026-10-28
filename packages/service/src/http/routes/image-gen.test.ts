import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImageProvider } from '../../providers/image/types.js';
import { type RunningService, startService } from '../../service.js';
import {
  renderedModelPromptGuide,
  requestedImageSize,
  resolveRecommendedImageSteps,
} from './image-gen.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

// 30s hook timeouts — startService boot races contention from the
// other integration files when they all run in the same `pnpm test`
// invocation; the 10s default trips occasionally.
beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-image-gen-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('POST /api/image-gen/generate', () => {
  it('returns an artifact path and writes a real PNG to disk', async () => {
    const res = await api('POST', '/api/image-gen/generate', {
      prompt: 'a tiny compass',
      width: 8,
      height: 8,
      seed: 1234,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifactPath: string;
      workspacePath: string | null;
      meta: { model: string; seed: number; widthPx: number; heightPx: number };
    };
    expect(body.artifactPath.startsWith('generated/')).toBe(true);
    expect(body.artifactPath.endsWith('.png')).toBe(true);
    expect(body.meta.seed).toBe(1234);
    expect(body.meta.widthPx).toBe(8);
    expect(body.meta.heightPx).toBe(8);

    const fileOnDisk = join(home, 'projects', 'default', 'artifacts', body.artifactPath);
    const bytes = await readFile(fileOnDisk);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('also drops a workspace copy at assets/generated/ for HTML embedding', async () => {
    const res = await api('POST', '/api/image-gen/generate', {
      prompt: 'a workspace-bound logo',
      width: 8,
      height: 8,
      seed: 5678,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifactPath: string;
      workspacePath: string | null;
    };
    // The default project allows workspace writes, so the route should
    // have produced both copies.
    expect(body.workspacePath).not.toBeNull();
    // Short, seed-keyed filename — small models can copy this verbatim
    // into <img src=...> without inventing a clean alias.
    expect(body.workspacePath).toBe('assets/generated/image-5678.png');

    const onDisk = join(home, 'projects', 'default', 'workspace', body.workspacePath ?? '');
    const bytes = await readFile(onDisk);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    // Both copies should be byte-identical — workspace is a duplicate,
    // not a re-encode.
    const artifactBytes = await readFile(
      join(home, 'projects', 'default', 'artifacts', body.artifactPath),
    );
    expect(bytes.equals(artifactBytes)).toBe(true);
  });

  it('keeps separate workspace copies when cloud images have no seed', async () => {
    const mock = await svc.context.imageProvider.current();
    const output = await mock.generate({ prompt: 'cloud fixture', width: 8, height: 8 });
    const routing = vi.spyOn(svc.context.imageProvider, 'providerForModel').mockResolvedValue({
      name: 'copilot',
      generate: async () => ({ ...output, meta: { ...output.meta, seed: 0 } }),
    } as unknown as ImageProvider);
    try {
      const paths: string[] = [];
      for (const prompt of ['first', 'second']) {
        const res = await api('POST', '/api/image-gen/generate', { prompt });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { workspacePath: string };
        paths.push(body.workspacePath);
        expect(
          await readFile(join(home, 'projects', 'default', 'workspace', body.workspacePath)),
        ).toEqual(output.png);
      }
      expect(paths[0]).not.toBe(paths[1]);
    } finally {
      routing.mockRestore();
    }
  });

  it("holds an agent's steps at the model's recommendation and fits the size to its range", async () => {
    const capped = await api('POST', '/api/image-gen/generate', {
      prompt: 'a tiny compass',
      model: 'sd-turbo',
      steps: 50,
      capStepsAtRecommended: true,
      width: 128,
      height: 128,
    });
    expect(capped.status).toBe(200);
    const meta = ((await capped.json()) as { meta: { steps: number; widthPx: number } }).meta;
    expect(meta.steps).toBe(4);
    expect(meta.widthPx).toBe(256);

    const uncapped = await api('POST', '/api/image-gen/generate', {
      prompt: 'a tiny compass',
      model: 'sd-turbo',
      steps: 8,
    });
    expect(((await uncapped.json()) as { meta: { steps: number } }).meta.steps).toBe(8);
  });

  it("holds an agent's size to a megapixel on a local engine and says so", async () => {
    const local = await svc.context.imageProvider.current();
    const generate = vi.spyOn(local, 'generate');
    try {
      const res = await api('POST', '/api/image-gen/generate', {
        prompt: 'a wide compass',
        width: 1600,
        height: 900,
        capSizeForAgent: true,
      });
      expect(res.status).toBe(200);
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ width: 1024, height: 576 }));
      const meta = ((await res.json()) as { meta: { settingsNotes?: string[] } }).meta;
      expect(meta.settingsNotes).toEqual([
        'Request normalized for agent image generation (size 1600x900 -> 1024x576).',
      ]);
    } finally {
      generate.mockRestore();
    }
  });

  it("passes an agent's exact size through to a cloud provider", async () => {
    const mock = await svc.context.imageProvider.current();
    const output = await mock.generate({ prompt: 'cloud fixture', width: 8, height: 8 });
    const generate = vi.fn(async () => output);
    const routing = vi
      .spyOn(svc.context.imageProvider, 'providerForModel')
      .mockResolvedValue({ name: 'openai', generate } as unknown as ImageProvider);
    try {
      const res = await api('POST', '/api/image-gen/generate', {
        prompt: 'a wide compass',
        width: 1536,
        height: 1024,
        capSizeForAgent: true,
      });
      expect(res.status).toBe(200);
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ width: 1536, height: 1024 }));
      const meta = ((await res.json()) as { meta: { settingsNotes?: string[] } }).meta;
      expect(meta.settingsNotes).toBeUndefined();
    } finally {
      routing.mockRestore();
    }
  });

  /** A local engine with these models installed, recording what each render was handed. */
  async function withLocalModels(
    installed: Array<{ id: string; name: string; editOnly?: boolean }>,
    defaultModel: string | undefined,
    body: Record<string, unknown>,
  ) {
    const mock = await svc.context.imageProvider.current();
    const output = await mock.generate({ prompt: 'fixture', width: 8, height: 8 });
    const rendered: Array<{ model?: string; width?: number; height?: number; sources: number }> =
      [];
    const routing = vi.spyOn(svc.context.imageProvider, 'providerForModel').mockResolvedValue({
      name: 'mock',
      listInstalledModels: async () =>
        installed.map((m) => ({ ...m, approxSizeBytes: 1, installedAt: '2026-10-27T00:00:00Z' })),
      resolveDefaultModelId: async () => defaultModel,
      generate: async (opts: {
        model?: string;
        width?: number;
        height?: number;
        inputImages?: unknown[];
      }) => {
        rendered.push({
          model: opts.model,
          width: opts.width,
          height: opts.height,
          sources: opts.inputImages?.length ?? 0,
        });
        return output;
      },
    } as unknown as ImageProvider);
    try {
      const res = await api('POST', '/api/image-gen/generate', body);
      return { status: res.status, json: (await res.json()) as Record<string, unknown>, rendered };
    } finally {
      routing.mockRestore();
    }
  }

  async function sourcePng(width: number, height: number) {
    const mock = await svc.context.imageProvider.current();
    return (await mock.generate({ prompt: 'source', width, height })).png.toString('base64');
  }

  it("edits with an installed editing model, in the source's shape", async () => {
    const data = await sourcePng(160, 90);
    const { status, rendered } = await withLocalModels(
      [
        { id: 'sdxl-base-1.0', name: 'SDXL' },
        { id: 'flux-2-klein-4b-q4', name: 'Klein' },
      ],
      'sdxl-base-1.0',
      { prompt: 'make the car blue', inputImages: [{ data, mimeType: 'image/png' }] },
    );
    expect(status).toBe(200);
    expect(rendered).toEqual([
      { model: 'flux-2-klein-4b-q4', width: 1344, height: 768, sources: 1 },
    ]);
  });

  it('refuses an edit request with no picture to change', async () => {
    const { status, json, rendered } = await withLocalModels(
      [{ id: 'flux-2-klein-4b-q4', name: 'Klein' }],
      undefined,
      { prompt: 'make the car blue', requireEdit: true },
    );
    expect(status).toBe(400);
    expect(json.code).toBe('image_source_required');
    expect(rendered).toEqual([]);
  });

  it('refuses an edit request when no installed model can edit, instead of drawing', async () => {
    const { status, json, rendered } = await withLocalModels(
      [{ id: 'krea-2-turbo-q4', name: 'Krea' }],
      'krea-2-turbo-q4',
      {
        prompt: 'make the car blue',
        requireEdit: true,
        inputImages: [{ data: await sourcePng(16, 16), mimeType: 'image/png' }],
      },
    );
    expect(status).toBe(409);
    expect(json.code).toBe('image_edit_unavailable');
    expect(rendered).toEqual([]);
  });

  it('refuses an edit-only model a fresh picture before its engine loads', async () => {
    const editOnly = [
      { id: 'qwen-image-edit-2511-q4', name: 'Qwen Image Edit 2511', editOnly: true },
    ];
    for (const body of [
      { prompt: 'a lighthouse', model: 'qwen-image-edit-2511-q4' },
      { prompt: 'a lighthouse' },
    ]) {
      const { status, json, rendered } = await withLocalModels(editOnly, undefined, body);
      expect(status).toBe(400);
      expect(json.code).toBe('image_source_required');
      expect(json.error).toMatch(/^Qwen Image Edit 2511 changes a picture/);
      expect(rendered).toEqual([]);
    }
  });

  it('rejects an empty prompt with 400', async () => {
    const res = await api('POST', '/api/image-gen/generate', { prompt: '' });
    expect(res.status).toBe(400);
  });

  it('honors `saveAs` for the workspace copy (artifact path stays seed-keyed)', async () => {
    const res = await api('POST', '/api/image-gen/generate', {
      prompt: 'a pinned-name logo',
      width: 8,
      height: 8,
      seed: 9999,
      saveAs: 'logo.png',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifactPath: string; workspacePath: string | null };
    expect(body.workspacePath).toBe('logo.png');
    expect(body.artifactPath).toMatch(/^generated\/.*-9999\.png$/);

    const onDisk = join(home, 'projects', 'default', 'workspace', 'logo.png');
    const bytes = await readFile(onDisk);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('rejects `saveAs` paths with traversal segments or missing extension', async () => {
    for (const bad of ['../escape.png', '/abs.png', 'no-ext', 'sub/./logo.png']) {
      const res = await api('POST', '/api/image-gen/generate', {
        prompt: 'x',
        width: 8,
        height: 8,
        saveAs: bad,
      });
      expect(res.status, `expected 400 for saveAs=${bad}`).toBe(400);
    }
  });
});

describe('GET /api/image-gen/models', () => {
  it('returns an empty list on a fresh install', async () => {
    const res = await api('GET', '/api/image-gen/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(Array.isArray(body.models)).toBe(true);
  });

  it('says how each model edits and which one an edit uses', async () => {
    const listing = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      id,
      name,
      approxSizeBytes: 1,
      installedAt: '2026-10-27T00:00:00Z',
      ...extra,
    });
    const current = vi.spyOn(svc.context.imageProvider, 'current').mockResolvedValue({
      name: 'sd-cpp',
      listInstalledModels: async () => [
        listing('krea-2-turbo-q4', 'Krea'),
        listing('qwen-image-edit-2511-q4', 'Qwen Edit', {
          editMode: 'reference',
          maxSourceImages: 3,
          editOnly: true,
        }),
        // An older engine lists no edit facts; the route resolves them.
        listing('flux-2-klein-4b-q4', 'Klein'),
      ],
      resolveDefaultModelId: async () => 'krea-2-turbo-q4',
    } as unknown as ImageProvider);
    try {
      const body = (await (await api('GET', '/api/image-gen/models')).json()) as {
        defaultModel?: string;
        defaultEditModel?: string;
        models: Array<Record<string, unknown>>;
      };
      expect(body.defaultModel).toBe('krea-2-turbo-q4');
      expect(body.defaultEditModel).toBe('qwen-image-edit-2511-q4');
      const byId = new Map(body.models.map((m) => [m.id, m]));
      expect(byId.get('krea-2-turbo-q4')).toMatchObject({ supportsImg2Img: false });
      expect(byId.get('krea-2-turbo-q4')?.editMode).toBeUndefined();
      expect(byId.get('qwen-image-edit-2511-q4')).toMatchObject({
        supportsImg2Img: true,
        editMode: 'reference',
        editOnly: true,
      });
      expect(byId.get('flux-2-klein-4b-q4')).toMatchObject({
        supportsImg2Img: true,
        editMode: 'reference',
        maxSourceImages: 3,
      });
    } finally {
      current.mockRestore();
    }
  });
});

describe('DELETE /api/image-gen/models/:id', () => {
  it("is idempotent when the model isn't installed", async () => {
    const res = await api('DELETE', '/api/image-gen/models/never-installed');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe('resolveRecommendedImageSteps', () => {
  it('uses the first installed image model when the request omits model', async () => {
    const steps = await resolveRecommendedImageSteps(
      {
        catalog: {
          get: async (kind: string, id: string) => ({
            kind,
            id,
            manifest: { kind: 'image-model', id, recommendedSteps: 4 },
          }),
        },
      } as never,
      {
        listInstalledModels: async () => [
          {
            id: 'sdxl-lightning-4step',
            name: 'SDXL Lightning',
            approxSizeBytes: 1,
            installedAt: new Date().toISOString(),
          },
        ],
      },
      undefined,
    );

    expect(steps).toBe(4);
  });

  it("uses the provider's configured default, not the first installed model", async () => {
    const steps = await resolveRecommendedImageSteps(
      {
        catalog: {
          get: async (_kind: string, id: string) => ({
            manifest: {
              kind: 'image-model',
              id,
              recommendedSteps: id === 'moss-image-sft-q4' ? 50 : 28,
            },
          }),
        },
      } as never,
      {
        listInstalledModels: async () => [
          {
            id: 'animagine-xl-4',
            name: 'Animagine XL 4.0',
            approxSizeBytes: 1,
            installedAt: new Date().toISOString(),
          },
        ],
        resolveDefaultModelId: async () => 'moss-image-sft-q4',
      },
      undefined,
    );

    expect(steps).toBe(50);
  });

  it('uses the explicitly requested model without listing installed models', async () => {
    const steps = await resolveRecommendedImageSteps(
      {
        catalog: {
          get: async (_kind: string, id: string) => ({
            manifest: { kind: 'image-model', id, recommendedSteps: 30 },
          }),
        },
      } as never,
      {
        listInstalledModels: async () => {
          throw new Error('should not list models');
        },
      },
      'sdxl-base-1.0',
    );

    expect(steps).toBe(30);
  });
});

describe('renderedModelPromptGuide', () => {
  it("reads a local model's traits from its catalog entry and its engine guidance", () => {
    expect(
      renderedModelPromptGuide(
        'local',
        {
          id: 'flux-2-klein-4b-q4',
          name: 'FLUX.2 Klein',
          promptStyle: 'sentences',
          rendersText: true,
        },
        'flux-2-klein-4b-q4',
      ),
    ).toBe(
      'FLUX.2 Klein reads plain descriptive sentences; can letter short text: put the exact words in quotes; ignores negative prompts, so leave unwanted things out of the prompt instead.',
    );
    expect(
      renderedModelPromptGuide(
        'local',
        { id: 'animagine-xl-4', name: 'Animagine XL 4', promptStyle: 'tags', rendersText: false },
        'animagine-xl-4',
      ),
    ).toMatch(/booru tags.*cannot letter text reliably, so leave words out of the image\.$/);
  });

  it('says nothing for a local model the catalog does not list', () => {
    expect(renderedModelPromptGuide('local', undefined, 'mystery')).toBeUndefined();
  });

  it('describes a cloud model by its id', () => {
    expect(renderedModelPromptGuide('cloud', undefined, 'gpt-image-2')).toMatch(
      /^gpt-image-2 reads plain descriptive sentences/,
    );
  });
});

describe('requestedImageSize', () => {
  const flux = {
    id: 'flux-2-klein-4b-q4',
    widthRange: { min: 512, max: 2048 },
    heightRange: { min: 512, max: 2048 },
  };
  const ming = {
    id: 'ming-image-0.1-design-bf16',
    widthRange: { min: 1024, max: 2048 },
    heightRange: { min: 1024, max: 2048 },
  };

  it('resolves a shape against the catalog model, inside its range', () => {
    expect(requestedImageSize({ aspectRatio: '9:16' }, flux, 'local')).toEqual({
      width: 768,
      height: 1344,
    });
    expect(requestedImageSize({ aspectRatio: '9:16' }, ming, 'local')).toEqual({
      width: 1024,
      height: 1792,
    });
    expect(requestedImageSize({ width: 768, height: 768 }, ming, 'local')).toEqual({
      width: 1024,
      height: 1024,
    });
  });

  it('renders the trained square when a catalog model is asked for nothing', () => {
    expect(requestedImageSize({}, flux, 'local')).toEqual({ width: 1024, height: 1024 });
  });

  it('resolves a shape for a local model the catalog does not list, by its id', () => {
    expect(
      requestedImageSize(
        { model: 'remote:studio/flux-2-klein-4b-q4', aspectRatio: '16:9' },
        undefined,
        'local',
      ),
    ).toEqual({ width: 1344, height: 768 });
  });

  it('hands a cloud provider only what was asked', () => {
    expect(
      requestedImageSize({ aspectRatio: '9:16', quality: 'high' }, undefined, 'cloud'),
    ).toEqual({});
    expect(requestedImageSize({ width: 800, height: 600 }, undefined, 'cloud')).toEqual({
      width: 800,
      height: 600,
    });
  });
});

describe('POST /api/image-gen/models/:id/pull', () => {
  it('returns 404 for an unknown catalog id', async () => {
    const res = await api('POST', '/api/image-gen/models/does-not-exist/pull');
    expect(res.status).toBe(404);
  });
});

describe('image generation for an outside AI app', () => {
  const harnessCall = (body: unknown) => {
    const harness = svc.context.tokenStore.issueHarness({
      client: 'codex',
      projectId: 'default',
      appName: 'Codex',
    });
    return httpFetch(`${baseUrl}/api/image-gen/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${harness.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  it('renders on this computer and never copies into the folder', async () => {
    const res = await harnessCall({
      prompt: 'a tiny compass',
      width: 8,
      height: 8,
      projectId: 'default',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifactPath: string; workspacePath: string | null };
    expect(body.artifactPath.startsWith('generated/')).toBe(true);
    expect(body.workspacePath).toBeNull();
  });

  it('refuses when the person turned image generation off for other apps', async () => {
    await svc.context.store.writeConfig({ harnessTools: { images: 'off' } });
    try {
      const res = await harnessCall({
        prompt: 'a tiny compass',
        width: 8,
        height: 8,
        projectId: 'default',
      });
      expect(res.status).toBe(403);
    } finally {
      await svc.context.store.writeConfig({ harnessTools: {} });
    }
  });

  it.each(['copilot', 'codex-cli'])(
    'treats %s as cloud for outside-app permissions',
    async (name) => {
      const generate = vi.fn();
      const routing = vi.spyOn(svc.context.imageProvider, 'providerForModel').mockResolvedValue({
        name,
        generate,
      } as unknown as ImageProvider);
      try {
        await svc.context.store.writeConfig({ harnessTools: { images: 'local' } });
        const res = await harnessCall({ prompt: 'a tiny compass', projectId: 'default' });
        expect(res.status).toBe(403);
        expect(generate).not.toHaveBeenCalled();
      } finally {
        routing.mockRestore();
        await svc.context.store.writeConfig({ harnessTools: {} });
      }
    },
  );
});
