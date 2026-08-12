import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { resolveEnrichTarget } from './enrich.js';

const priorModel = process.env.GEZEL_ENRICH_MODEL;
const priorProvider = process.env.GEZEL_ENRICH_PROVIDER;
beforeAll(() => {
  delete process.env.GEZEL_ENRICH_MODEL;
  delete process.env.GEZEL_ENRICH_PROVIDER;
});
afterAll(() => {
  if (priorModel !== undefined) process.env.GEZEL_ENRICH_MODEL = priorModel;
  if (priorProvider !== undefined) process.env.GEZEL_ENRICH_PROVIDER = priorProvider;
});

const storeWith = (cfg: unknown): Store => ({ readConfig: async () => cfg }) as unknown as Store;

describe('resolveEnrichTarget', () => {
  it('honors an explicit cloud provider+model pinned on the Boekwachter', async () => {
    const target = await resolveEnrichTarget(storeWith({ defaultModel: { mlx: 'qwen-local' } }), {
      boekwachter: { id: 'b', name: 'Mhairi', provider: 'codex-cli', model: 'gpt-5.6-sol' },
    });
    expect(target).toEqual({ providerName: 'codex-cli', model: 'gpt-5.6-sol' });
  });

  it('keeps honoring a local pin', async () => {
    const target = await resolveEnrichTarget(storeWith({ defaultModel: { mlx: 'qwen-local' } }), {
      boekwachter: { id: 'b', name: 'Noor', provider: 'llama-cpp', model: 'small-4b' },
    });
    expect(target).toEqual({ providerName: 'llama-cpp', model: 'small-4b' });
  });

  it('an incomplete pin (provider without model) falls back to local-first', async () => {
    const target = await resolveEnrichTarget(storeWith({ defaultModel: { mlx: 'qwen-local' } }), {
      boekwachter: { id: 'b', name: 'Mhairi', provider: 'codex-cli' },
    });
    expect(target).toEqual({ providerName: 'mlx', model: 'qwen-local' });
  });

  it('never drifts to a cloud config default without a pin', async () => {
    const target = await resolveEnrichTarget(
      storeWith({ provider: 'codex-cli', defaultModel: { 'codex-cli': 'gpt-5.6-sol' } }),
      { boekwachter: { id: 'b', name: 'Mhairi' } },
    );
    expect(target).toBeNull();
  });

  it('the Night Shift override outranks the Boekwachter pin', async () => {
    const target = await resolveEnrichTarget(
      storeWith({
        nightShift: { modelOverride: { enabled: true, provider: 'openai', model: 'gpt-night' } },
      }),
      {
        nightShift: true,
        boekwachter: { id: 'b', name: 'Mhairi', provider: 'codex-cli', model: 'gpt-5.6-sol' },
      },
    );
    expect(target).toEqual({ providerName: 'openai', model: 'gpt-night' });
  });
});
