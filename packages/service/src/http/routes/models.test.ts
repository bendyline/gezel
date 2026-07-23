import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { modelsRoutes } from './models.js';

function contextWithListModels(
  listModelsForProvider: ServiceContext['chat']['listModelsForProvider'],
): ServiceContext {
  return {
    chat: { listModelsForProvider },
  } as unknown as ServiceContext;
}

describe('GET / — provider model picker', () => {
  it('represents an unavailable optional provider as an empty list', async () => {
    const listModelsForProvider = vi.fn(async () => {
      throw new Error('provider is not configured');
    });
    const app = modelsRoutes(contextWithListModels(listModelsForProvider));

    const response = await app.request('/?provider=openai&refresh=1');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: 'openai', models: [] });
  });

  it('keeps provider diagnostics on the explicit connection-test endpoint', async () => {
    const listModelsForProvider = vi.fn(async () => {
      throw new Error('provider is not configured');
    });
    const app = modelsRoutes(contextWithListModels(listModelsForProvider));

    const response = await app.request('/test?provider=openai');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      provider: 'openai',
      error: 'provider is not configured',
    });
  });
});
