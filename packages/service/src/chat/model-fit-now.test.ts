import type { ChatModelManifest, ChatSession, GezelConfig } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { LiveLaunchView } from '../providers/llama-cpp/hardware-tier.js';
import { type ModelFitDeps, installedModelsFitNow, sessionModelFitNow } from './model-fit-now.js';

const GB = 1024 ** 3;

function manifest(id: string, name: string, sizeGb: number, recoScore?: number): ChatModelManifest {
  return {
    kind: 'chat-model',
    id,
    name,
    supportsTools: true,
    approxSizeBytes: sizeGb * GB,
    ...(recoScore !== undefined ? { recoScore } : {}),
    llamaCpp: { huggingfaceRepo: 'r', filename: `${id}.gguf`, approxSizeBytes: sizeGb * GB },
  } as unknown as ChatModelManifest;
}

/** The 12 GB laptop from the review: 11.34 GB of card, 7.7 GB of RAM free. */
const laptop: LiveLaunchView = {
  platform: 'win32',
  machine: { totalRamBytes: 31 * GB, gpuVramBytes: 12 * GB },
  device: {
    platform: 'win32',
    gpuVramBytes: 12 * GB,
    gpuMemoryKind: 'discrete',
    totalRamBytes: 31 * GB,
    usableBytes: 11.34 * GB,
    budgetBytes: 30 * GB,
    launchCapBytes: 15.4 * GB,
    freeGpuBytes: 11.5 * GB,
  },
  inputs: { platform: 'win32', totalRamBytes: 31 * GB, usableBytes: 11.34 * GB },
};

function deps(over: {
  config?: Partial<GezelConfig>;
  record?: Partial<ChatSession>;
  pinned?: string;
  installed?: string[];
}): ModelFitDeps {
  const catalog = [
    manifest('qwen3.6-35b-a3b-q4', 'Qwen 3.6 (35B-A3B, Q4)', 21.1, 20),
    manifest('gemma4-12b-q4', 'Gemma 4 (12B, Q4)', 6.3, 15),
    manifest('gemma4-e4b-q4', 'Gemma 4 (E4B, Q4)', 3.9, 15),
  ];
  return {
    store: {
      readConfig: async () =>
        ({ defaultModel: { 'llama-cpp': 'qwen3.6-35b-a3b-q4' }, ...over.config }) as GezelConfig,
      getGezel: async () =>
        ({ parsed: { frontmatter: over.pinned ? { model: over.pinned } : {} } }) as never,
    },
    chat: {
      getSessionRecord: async (id: string) =>
        id === 'missing'
          ? null
          : ({ id, gezelId: 'meester', providerName: 'llama-cpp', ...over.record } as ChatSession),
      listModelsForProvider: async () =>
        (over.installed ?? ['qwen3.6-35b-a3b-q4', 'gemma4-12b-q4', 'gemma4-e4b-q4']).map((id) => ({
          id,
          name: id,
        })),
    },
    catalog: { list: async () => catalog.map((m) => ({ manifest: m })) as never },
    launchView: async () => laptop,
  };
}

describe('sessionModelFitNow', () => {
  it('says the 35B would not start, and offers the best model that would', async () => {
    const fit = await sessionModelFitNow(deps({}), 's1');
    expect(fit).toEqual({
      provider: 'llama-cpp',
      model: 'qwen3.6-35b-a3b-q4',
      followsDefault: true,
      startsNow: false,
      alternative: { model: 'gemma4-12b-q4', name: 'Gemma 4 (12B, Q4)' },
    });
  });

  it('says yes, with nothing to switch to, once the default is a model that fits', async () => {
    const fit = await sessionModelFitNow(
      deps({ config: { defaultModel: { 'llama-cpp': 'gemma4-12b-q4' } } }),
      's1',
    );
    expect(fit).toMatchObject({ model: 'gemma4-12b-q4', startsNow: true });
    expect(fit?.alternative).toBeUndefined();
  });

  it('reports a pinned gezel as not following the default', async () => {
    const fit = await sessionModelFitNow(deps({ pinned: 'qwen3.6-35b-a3b-q4' }), 's1');
    expect(fit).toMatchObject({ startsNow: false, followsDefault: false });
  });

  it('suggests a model that fits the card over a higher-scored one that only squeezes in', async () => {
    const d = deps({ installed: ['qwen3.6-35b-a3b-q4', 'gemma4-12b-q4', 'qwen3.8-27b-q3'] });
    const list = d.catalog.list;
    d.catalog = {
      list: async (kind) => {
        const items = (await list(kind)) as Array<{ manifest: ChatModelManifest }>;
        return [
          ...items.map((i) => ({ manifest: { ...i.manifest, licenseClass: 'open' } })),
          // Dense and larger than the card: it would load, slowly, from RAM.
          {
            manifest: {
              ...manifest('qwen3.8-27b-q3', 'Qwen 3.8 (27B, Q3)', 12.2, 22),
              licenseClass: 'open',
            },
          },
        ] as never;
      },
    };
    const fit = await sessionModelFitNow(d, 's1');
    expect(fit?.alternative?.model).toBe('gemma4-12b-q4');
  });

  it('offers nothing when no installed model would start', async () => {
    const fit = await sessionModelFitNow(deps({ installed: ['qwen3.6-35b-a3b-q4'] }), 's1');
    expect(fit).toMatchObject({ startsNow: false });
    expect(fit?.alternative).toBeUndefined();
  });

  it('has no opinion about a cloud session', async () => {
    const fit = await sessionModelFitNow(deps({ record: { providerName: 'openai' } }), 's1');
    expect(fit?.startsNow).toBeNull();
  });

  it('returns null for a session that does not exist', async () => {
    expect(await sessionModelFitNow(deps({}), 'missing')).toBeNull();
  });
});

describe('installedModelsFitNow', () => {
  it('gives every installed model the launch check’s verdict', async () => {
    const fit = await installedModelsFitNow(deps({}), 'llama-cpp');
    expect(fit?.launchCapBytes).toBe(Math.round(15.4 * GB));
    const byId = Object.fromEntries((fit?.models ?? []).map((m) => [m.id, m.startsNow]));
    expect(byId).toEqual({
      'qwen3.6-35b-a3b-q4': false,
      'gemma4-12b-q4': true,
      'gemma4-e4b-q4': true,
    });
  });

  it('has nothing to say about a cloud provider', async () => {
    expect(await installedModelsFitNow(deps({}), 'openai')).toBeNull();
  });
});
