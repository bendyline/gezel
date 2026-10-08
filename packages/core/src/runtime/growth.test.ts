import { describe, expect, it, vi } from 'vitest';
import type { GezelGrowthResponse } from '../schemas/api.js';
import type { GezelDetail } from '../schemas/gezel.js';
import { type PortableInference, PortableProductService } from './product-service.js';
import { portableFixture } from './test-files.js';

const NOTES = [
  'Prefers a worked example before the rule.',
  'Prefers a worked example before any explanation.',
  ...Array.from({ length: 16 }, (_, i) => `Preference number ${i}: short answers first.`),
];

async function fixture(social?: boolean) {
  const { store } = portableFixture();
  const inference: PortableInference = {
    providers: async () => [
      {
        id: 'llama-cpp',
        name: 'Local fixture',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 8192,
        maxOutputTokens: 1000,
        capabilities: {
          text: true,
          tools: false,
          images: false,
          structuredOutput: false,
          foregroundOnly: true,
        },
      },
    ],
    generate: vi.fn(async () => ({
      text: [
        'PROPOSAL',
        'TITLE: Examples before rules',
        'TRAIT: Show a worked example before stating the rule.',
        `EVIDENCE: ${new Date().toISOString().slice(0, 10)} :: ${NOTES[0]}`,
        'END',
      ].join('\n'),
      stopReason: 'stop' as const,
    })),
    cancel: vi.fn(async () => {}),
  };
  const service = new PortableProductService(store, inference, 'secret');
  await service.initialize();
  if (social !== undefined) await store.writeConfig({ social });
  const gezelId = (await store.readConfig()).meesterGezelId!;
  for (const text of NOTES)
    await store.saveMemory({ scope: 'gezel', id: gezelId, kind: 'pref', text });
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await service.fetch(`https://gezel.local${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };
  return { store, service, inference, gezelId, request };
}

describe('growth on the phone', () => {
  it('earns XP from what a gezel wrote down, offers a level-up, and adopts the chosen trait', async () => {
    const { store, gezelId, request, inference } = await fixture();
    const session = await store.createSession({
      gezelId,
      projectId: 'default',
      providerName: 'llama-cpp',
    });

    const refreshed = await request<GezelGrowthResponse>(
      `/api/gezels/${gezelId}/growth/refresh`,
      {},
    );
    expect(refreshed.state.xp).toBeGreaterThanOrEqual(100);
    const pending = refreshed.state.pendingLevelUp!;
    expect(pending.toLevel).toBe(2);
    expect(inference.generate).toHaveBeenCalledOnce();
    const trait = pending.proposals.find((p) => p.kind === 'trait');
    expect(trait).toMatchObject({ traitText: 'Show a worked example before stating the rule.' });
    expect(pending.proposals.map((p) => p.kind)).toEqual(['trait', 'tuning', 'cosmetic']);

    // Social mode is on by default here, so the gezel says so in its latest chat.
    const announced = await store.getSession(gezelId, session.id);
    expect(announced?.messages.at(-1)).toMatchObject({ synthetic: 'growth-announcement' });

    const accepted = await request<GezelGrowthResponse>(`/api/gezels/${gezelId}/growth/accept`, {
      proposalId: trait!.id,
    });
    expect(accepted.state.level).toBe(2);
    expect(accepted.state.pendingLevelUp).toBeUndefined();
    expect(accepted.activeTraits.map((t) => t.text)).toEqual([
      'Show a worked example before stating the rule.',
    ]);
    const gezel = await request<GezelDetail>(`/api/gezels/${gezelId}`);
    expect(gezel.growth).toEqual({ level: 2 });
  });

  it('holds the announcement while social mode is off', async () => {
    const { store, gezelId, request } = await fixture(false);
    const session = await store.createSession({
      gezelId,
      projectId: 'default',
      providerName: 'llama-cpp',
    });
    const refreshed = await request<GezelGrowthResponse>(
      `/api/gezels/${gezelId}/growth/refresh`,
      {},
    );
    expect(refreshed.state.pendingLevelUp?.toLevel).toBe(2);
    expect((await store.getSession(gezelId, session.id))?.messages).toEqual([]);
  });

  it('skips a level, declining what it offered', async () => {
    const { gezelId, request } = await fixture();
    await request(`/api/gezels/${gezelId}/growth/refresh`, {});
    const skipped = await request<GezelGrowthResponse>(`/api/gezels/${gezelId}/growth/decline`, {});
    expect(skipped.state.level).toBe(2);
    expect(skipped.state.declinedProposals.map((d) => d.kind)).toEqual(['trait']);
  });
});
