import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GezelGrowthState,
  type GezelTrait,
  type GrowthProposal,
  xpForLevel,
} from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { gezelGrowthPath } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-growth-route-'));
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

async function createGezel(name: string): Promise<string> {
  const res = await api('POST', '/api/gezels', { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * Seed growth.json directly — the engine's signal/threshold math is
 * covered in growth/engine.test.ts; these tests exercise the routes'
 * resolution semantics against known pending states. A fresh
 * `lastComputedAt` keeps the GET route's background refresh from firing
 * and racing the seeded writes.
 */
async function seedGrowth(gezelId: string, overrides: Partial<GezelGrowthState>): Promise<void> {
  const state: GezelGrowthState = {
    version: 1,
    level: 1,
    xp: 150,
    signals: { memoryXp: 150, lessonsXp: 0, taskXp: 0, consultXp: 0 },
    lastComputedAt: new Date().toISOString(),
    adoptedTraits: [],
    declinedProposals: [],
    unlockedCosmetics: [],
    ...overrides,
  };
  await writeFile(gezelGrowthPath(home, gezelId), JSON.stringify(state, null, 2));
}

function traitProposal(id: string, text: string): GrowthProposal {
  return {
    id,
    kind: 'trait',
    title: 'Code commenting style',
    traitText: text,
    evidence: [
      {
        day: '2026-06-01',
        kind: 'pref',
        excerpt: 'User prefers sparse comments that explain why, not what.',
      },
    ],
  };
}

const TEMP_UP: GrowthProposal = {
  id: 'prop-temp',
  kind: 'tuning',
  title: 'Run a little warmer',
  description: 'Nudge sampling temperature up by 0.1.',
  action: { type: 'temperature', delta: 0.1 },
};

const COSMETIC: GrowthProposal = {
  id: 'prop-cos',
  kind: 'cosmetic',
  title: 'Straw hat',
  cosmeticId: 'hat.straw',
};

interface Payload {
  state: GezelGrowthState;
  nextLevelXp: number;
  activeTraits: GezelTrait[];
  driftedTraitIds: string[];
}

describe('GET /api/gezels/:id/growth', () => {
  it('404s for an unknown gezel', async () => {
    const res = await api('GET', '/api/gezels/nope-not-real/growth');
    expect(res.status).toBe(404);
  });

  it('returns level-1 defaults for a fresh gezel', async () => {
    const id = await createGezel('GrowthFresh');
    const res = await api('GET', `/api/gezels/${id}/growth`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;
    expect(body.state.level).toBe(1);
    expect(body.state.pendingLevelUp).toBeUndefined();
    expect(body.nextLevelXp).toBe(xpForLevel(2));
    expect(body.activeTraits).toEqual([]);
    expect(body.driftedTraitIds).toEqual([]);
  });

  it('flags adopted traits missing from frontmatter as drifted', async () => {
    const id = await createGezel('GrowthDrift');
    await seedGrowth(id, {
      level: 2,
      adoptedTraits: [
        {
          traitId: 'trait-gone',
          text: 'Explain why, not what, in comments.',
          level: 2,
          adoptedAt: new Date().toISOString(),
          evidence: [],
        },
      ],
    });
    const body = (await (await api('GET', `/api/gezels/${id}/growth`)).json()) as Payload;
    expect(body.driftedTraitIds).toEqual(['trait-gone']);
  });
});

describe('POST /api/gezels/:id/growth/accept', () => {
  it('accept trait: frontmatter gains it, level bumps, pending clears, siblings declined', async () => {
    const id = await createGezel('GrowthAcceptTrait');
    await seedGrowth(id, {
      pendingLevelUp: {
        toLevel: 2,
        proposals: [
          traitProposal('prop-a', 'Keep comments sparse — explain why, never what.'),
          traitProposal('prop-b', 'Always run the test suite before declaring done.'),
          COSMETIC,
        ],
        createdAt: new Date().toISOString(),
      },
    });

    const res = await api('POST', `/api/gezels/${id}/growth/accept`, { proposalId: 'prop-a' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;

    expect(body.state.level).toBe(2);
    expect(body.state.pendingLevelUp).toBeUndefined();
    expect(body.activeTraits).toHaveLength(1);
    expect(body.activeTraits[0]?.text).toBe('Keep comments sparse — explain why, never what.');
    expect(body.activeTraits[0]?.source).toBe('levelup');
    expect(body.driftedTraitIds).toEqual([]);

    // Audit record carries the evidence; the non-chosen TRAIT is declined
    // (never re-offered) but the cosmetic is not.
    expect(body.state.adoptedTraits).toHaveLength(1);
    expect(body.state.adoptedTraits[0]?.evidence).toHaveLength(1);
    expect(body.state.declinedProposals.map((d) => d.traitText)).toEqual([
      'Always run the test suite before declaring done.',
    ]);
    expect(body.state.unlockedCosmetics.map((u) => u.id)).toContain('level-2');

    // The gezel detail reflects the new frontmatter trait.
    const detail = (await (await api('GET', `/api/gezels/${id}`)).json()) as {
      traits?: GezelTrait[];
    };
    expect(detail.traits?.map((t) => t.text)).toEqual([
      'Keep comments sparse — explain why, never what.',
    ]);
  });

  it('accept temperature: clamps to ±20% of the current value', async () => {
    const id = await createGezel('GrowthAcceptTemp');
    // Base 0.4 → +0.1 would be 0.5, but the 20% envelope caps at 0.48.
    await svc.context.store.updateGezelSettings(id, {
      tuning: { sampling: { temperature: 0.4 } },
    });
    await seedGrowth(id, {
      pendingLevelUp: {
        toLevel: 2,
        proposals: [TEMP_UP, COSMETIC],
        createdAt: new Date().toISOString(),
      },
    });

    const res = await api('POST', `/api/gezels/${id}/growth/accept`, { proposalId: 'prop-temp' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;
    expect(body.state.level).toBe(2);
    expect(body.state.pendingLevelUp).toBeUndefined();

    const gezel = await svc.context.store.getGezel(id);
    expect(gezel?.parsed.frontmatter.tuning?.sampling?.temperature).toBe(0.48);
  });

  it('409s when nothing is pending and 400s on an unknown proposal', async () => {
    const id = await createGezel('GrowthAcceptGuards');
    const none = await api('POST', `/api/gezels/${id}/growth/accept`, { proposalId: 'prop-x' });
    expect(none.status).toBe(409);

    await seedGrowth(id, {
      pendingLevelUp: {
        toLevel: 2,
        proposals: [COSMETIC],
        createdAt: new Date().toISOString(),
      },
    });
    const unknown = await api('POST', `/api/gezels/${id}/growth/accept`, { proposalId: 'nope' });
    expect(unknown.status).toBe(400);
  });

  it('concurrent accepts resolve exactly once: one 200, one 409, one trait', async () => {
    const id = await createGezel('GrowthAcceptRace');
    await seedGrowth(id, {
      pendingLevelUp: {
        toLevel: 2,
        proposals: [
          traitProposal('prop-a', 'Prefer boring, proven solutions.'),
          traitProposal('prop-b', 'Sketch the data model before the code.'),
        ],
        createdAt: new Date().toISOString(),
      },
    });

    const [first, second] = await Promise.all([
      api('POST', `/api/gezels/${id}/growth/accept`, { proposalId: 'prop-a' }),
      api('POST', `/api/gezels/${id}/growth/accept`, { proposalId: 'prop-b' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);

    const payload = (await (await api('GET', `/api/gezels/${id}/growth`)).json()) as Payload;
    expect(payload.state.level).toBe(2);
    expect(payload.state.pendingLevelUp).toBeUndefined();
    expect(payload.state.adoptedTraits).toHaveLength(1);
    expect(payload.activeTraits).toHaveLength(1);
    expect(payload.driftedTraitIds).toEqual([]);
  });

  it('409s on the trait slot cap and keeps the pending unresolved', async () => {
    const id = await createGezel('GrowthSlotCap');
    for (let i = 0; i < 8; i++) {
      await svc.context.store.addGezelTrait(id, {
        id: `trait-seed-${i}`,
        text: `Standing behavior number ${i}.`,
        adoptedAt: new Date().toISOString(),
        source: 'manual',
      });
    }
    await seedGrowth(id, {
      pendingLevelUp: {
        toLevel: 2,
        proposals: [traitProposal('prop-nine', 'One trait too many.'), COSMETIC],
        createdAt: new Date().toISOString(),
      },
    });

    const res = await api('POST', `/api/gezels/${id}/growth/accept`, { proposalId: 'prop-nine' });
    expect(res.status).toBe(409);

    // Level-up still unresolved — the user can pick the cosmetic instead.
    const body = (await (await api('GET', `/api/gezels/${id}/growth`)).json()) as Payload;
    expect(body.state.level).toBe(1);
    expect(body.state.pendingLevelUp?.proposals).toHaveLength(2);
  });
});

describe('POST /api/gezels/:id/growth/decline', () => {
  it('declines a single proposal without advancing the level', async () => {
    const id = await createGezel('GrowthDeclineOne');
    await seedGrowth(id, {
      pendingLevelUp: {
        toLevel: 2,
        proposals: [traitProposal('prop-a', 'Trait under consideration.'), TEMP_UP, COSMETIC],
        createdAt: new Date().toISOString(),
      },
    });

    const res = await api('POST', `/api/gezels/${id}/growth/decline`, { proposalId: 'prop-a' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;
    expect(body.state.level).toBe(1);
    expect(body.state.pendingLevelUp?.proposals.map((p) => p.id)).toEqual([
      'prop-temp',
      'prop-cos',
    ]);
    expect(body.state.declinedProposals.map((d) => d.traitText)).toEqual([
      'Trait under consideration.',
    ]);
  });

  it('refuses to decline the last remaining option', async () => {
    const id = await createGezel('GrowthDeclineLast');
    await seedGrowth(id, {
      pendingLevelUp: {
        toLevel: 2,
        proposals: [COSMETIC],
        createdAt: new Date().toISOString(),
      },
    });
    const res = await api('POST', `/api/gezels/${id}/growth/decline`, { proposalId: 'prop-cos' });
    expect(res.status).toBe(400);
  });

  it('skip (no proposalId): level advances, traits declined, milestone unlocks', async () => {
    const id = await createGezel('GrowthSkip');
    await seedGrowth(id, {
      pendingLevelUp: {
        toLevel: 2,
        proposals: [traitProposal('prop-a', 'A skipped trait.'), TEMP_UP, COSMETIC],
        createdAt: new Date().toISOString(),
      },
    });

    const res = await api('POST', `/api/gezels/${id}/growth/decline`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;
    expect(body.state.level).toBe(2);
    expect(body.state.pendingLevelUp).toBeUndefined();
    // Only TRAIT proposals are recorded as declined; payouts stay offerable.
    expect(body.state.declinedProposals.map((d) => d.title)).toEqual(['Code commenting style']);
    expect(body.state.unlockedCosmetics.map((u) => u.id)).toContain('level-2');
    // Nothing was adopted; frontmatter untouched.
    expect(body.activeTraits).toEqual([]);

    const again = await api('POST', `/api/gezels/${id}/growth/decline`, {});
    expect(again.status).toBe(409);
  });
});

describe('DELETE /api/gezels/:id/growth/traits/:traitId', () => {
  it('retires a trait: frontmatter loses it, audit record gains removedAt', async () => {
    const id = await createGezel('GrowthRetire');
    await seedGrowth(id, {
      pendingLevelUp: {
        toLevel: 2,
        proposals: [traitProposal('prop-r', 'A trait we will retire.'), COSMETIC],
        createdAt: new Date().toISOString(),
      },
    });
    const accepted = (await (
      await api('POST', `/api/gezels/${id}/growth/accept`, { proposalId: 'prop-r' })
    ).json()) as Payload;
    const traitId = accepted.activeTraits[0]?.id;
    expect(traitId).toBeTruthy();

    const res = await api('DELETE', `/api/gezels/${id}/growth/traits/${traitId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;
    expect(body.activeTraits).toEqual([]);
    expect(body.state.adoptedTraits[0]?.removedAt).toBeTruthy();
    // Retired ≠ drifted — the removal was deliberate.
    expect(body.driftedTraitIds).toEqual([]);

    const again = await api('DELETE', `/api/gezels/${id}/growth/traits/${traitId}`);
    expect(again.status).toBe(404);
  });
});
