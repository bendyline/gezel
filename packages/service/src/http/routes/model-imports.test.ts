import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelImportReview } from '@bendyline/gezel';
import { CatalogService, ImportedChatModelsSource } from '@bendyline/gezel-catalog';
import { createImportedChatModelReader } from '@bendyline/gezel-inference/internal/models/imports/entry-store';
import { LlamaCppModelManager } from '@bendyline/gezel-inference/internal/providers/llama-cpp/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMIT, REPO, chatGguf, fakeHub } from '../../models/model-import-fixture.js';
import type { EngineContext } from '../engine-context.js';
import { modelImportRoutes } from './model-imports.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gezel-hf-routes-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function routes(files: Record<string, Buffer>) {
  const fetchImpl = fakeHub({ files });
  // The route builds its importer on the process fetch, the one it would use for real.
  vi.stubGlobal('fetch', fetchImpl);
  const catalog = new CatalogService([
    new ImportedChatModelsSource(createImportedChatModelReader({ home, env: {} })),
  ]);
  const llamaCppModels = new LlamaCppModelManager({
    home,
    catalog,
    fetchImpl,
    resolveBackend: () => 'cpu',
  });
  return modelImportRoutes({ home, catalog, llamaCppModels } as unknown as EngineContext);
}

function post(app: ReturnType<typeof routes>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/model-imports', () => {
  it('reviews, then confirms, a Hugging Face GGUF', async () => {
    const app = routes({ 'Tiny-Qwen-Q4_K_M.gguf': chatGguf() });
    const reviewRes = await post(app, '/review', { reference: `hf.co/${REPO}` });
    expect(reviewRes.status).toBe(200);
    const review = (await reviewRes.json()) as ModelImportReview;
    expect(review.blocked).toBe(false);
    expect(review.source).toMatchObject({ kind: 'huggingface', revision: COMMIT });

    const confirmRes = await post(app, '/confirm', {
      repo: REPO,
      revision: COMMIT,
      file: review.selectedFile,
    });
    expect(confirmRes.status).toBe(200);
    expect(await confirmRes.json()).toEqual({
      engine: 'llama-cpp',
      id: review.id,
      name: review.name,
    });
  });

  it('answers bad requests with a plain reason and the right status', async () => {
    const app = routes({ 'model.safetensors': Buffer.alloc(8) });
    expect((await post(app, '/review', {})).status).toBe(400);
    expect((await post(app, '/review', { reference: 'not a model' })).status).toBe(400);
    const noGguf = await post(app, '/review', { repo: REPO });
    expect(noGguf.status).toBe(422);
    expect(((await noGguf.json()) as { error: string }).error).toMatch(/no model Gezel can run/);
    expect(
      (await post(app, '/confirm', { repo: REPO, revision: 'main', file: 'x.gguf' })).status,
    ).toBe(400);
  });

  it('refuses to confirm a model that fails its checks', async () => {
    const app = routes({
      'm-Q4_K_M.gguf': chatGguf([['general.architecture', 'not-a-design']]),
    });
    const res = await post(app, '/confirm', {
      repo: REPO,
      revision: COMMIT,
      file: 'm-Q4_K_M.gguf',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Engine support/);
  });

  it('takes GGUF files from this computer through upload, review and confirm', async () => {
    const app = routes({});
    const created = await post(app, '/local', {});
    expect(created.status).toBe(201);
    const { importId } = (await created.json()) as { importId: string };
    const bytes = chatGguf();
    const base = `/local/${importId}`;
    const put = await app.request(`${base}/files/My-Model-Q4_K_M.gguf`, {
      method: 'PUT',
      body: bytes,
    });
    expect(put.status).toBe(201);
    const status = (await (await app.request(base)).json()) as { bytesReceived: number };
    expect(status.bytesReceived).toBe(bytes.length);
    const review = (await (await post(app, `${base}/review`, {})).json()) as ModelImportReview;
    expect(review.blocked).toBe(false);
    const confirm = await post(app, `${base}/confirm`, {});
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toMatchObject({
      engine: 'llama-cpp',
      id: review.id,
      installed: true,
    });
    expect((await app.request(base)).status).toBe(404);
  });
});
