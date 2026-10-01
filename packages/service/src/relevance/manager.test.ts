import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GezelConfig, securityPolicyForLevel } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelevanceModelManager } from './manager.js';
import type { RelevanceScorer } from './relevance-model.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-relevance-manager-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const idleScorer: RelevanceScorer = {
  status: () => 'cold',
  warm: async () => true,
  score: async () => ({ status: 'cold', scores: [], ms: 0, modelId: 'none' }),
};

/** Boot a manager on `config` and report whether it reached for the network. */
async function bootWith(config: Partial<GezelConfig>): Promise<string[]> {
  const fetched: string[] = [];
  const manager = new RelevanceModelManager({
    home,
    readConfig: async () => config as GezelConfig,
    scorer: idleScorer,
    fetchImpl: (async (url: string | URL) => {
      fetched.push(String(url));
      return new Response('not here', { status: 404 });
    }) as typeof fetch,
  });
  await manager.bootWarm();
  // The download runs in the background; give it a moment to make its first request.
  for (let i = 0; i < 50 && fetched.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return fetched;
}

describe('RelevanceModelManager.bootWarm', () => {
  it('downloads an enabled model that is not on disk — how a new install gets it', async () => {
    const fetched = await bootWith({
      relevanceModel: { enabled: true },
      securityPolicy: securityPolicyForLevel('lockdown'),
    });
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched[0]).toContain('ms-marco-MiniLM-L-6-v2');
  });

  it('downloads nothing while the check is off', async () => {
    expect(await bootWith({ securityPolicy: securityPolicyForLevel('lockdown') })).toEqual([]);
  });

  it('respects a security level with app network off', async () => {
    const fetched = await bootWith({
      relevanceModel: { enabled: true },
      securityPolicy: securityPolicyForLevel('super-lockdown'),
    });
    expect(fetched).toEqual([]);
  });
});
