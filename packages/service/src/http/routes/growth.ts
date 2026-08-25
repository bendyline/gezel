/**
 * Growth API — character sheet + the level-up consent loop. Every
 * mutation re-reads growth.json and verifies the pending/proposal before
 * acting (double-accept from a second window 409s), and every mutating
 * response returns the full refreshed payload so the UI swaps state in
 * atomically.
 */

import {
  type AdoptedTraitRecord,
  type DeclinedProposalRecord,
  type GezelGrowthResponse,
  type GezelGrowthState,
  type GezelTrait,
  type GrowthProposal,
  createLogger,
  xpForLevel,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

const log = createLogger('growth');

/** Re-fire a background signals refresh when the sheet is older than this. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

async function buildPayload(ctx: ServiceContext, gezelId: string): Promise<GezelGrowthResponse> {
  const state = await ctx.store.readGezelGrowth(gezelId);
  const gezel = await ctx.store.getGezel(gezelId).catch(() => null);
  const activeTraits = gezel?.parsed.frontmatter.traits ?? [];
  const activeIds = new Set(activeTraits.map((t) => t.id));
  const driftedTraitIds = state.adoptedTraits
    .filter((t) => !t.removedAt && !activeIds.has(t.traitId))
    .map((t) => t.traitId);
  return {
    state,
    nextLevelXp: xpForLevel(state.level + 1),
    activeTraits,
    driftedTraitIds,
  };
}

export function growthRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/growth', async (c) => {
    const gezelId = c.req.param('id');
    if (!(await ctx.store.getGezel(gezelId).catch(() => null))) {
      return c.json({ error: `gezel ${gezelId} not found` }, 404);
    }
    const payload = await buildPayload(ctx, gezelId);
    const computedAt = payload.state.lastComputedAt ? Date.parse(payload.state.lastComputedAt) : 0;
    if (Date.now() - computedAt > STALE_AFTER_MS) {
      // Background signals-only freshness pass — never creates a pending
      // (that's the sweep's job, with Klerk) and never blocks the GET.
      void ctx.growth
        .refresh(gezelId, { allowKlerk: false, createPending: false })
        .catch((err) => log.warn(`[growth] background refresh failed for ${gezelId}:`, err));
    }
    return c.json(payload);
  });

  app.post('/:id/growth/refresh', async (c) => {
    const gezelId = c.req.param('id');
    if (!(await ctx.store.getGezel(gezelId).catch(() => null))) {
      return c.json({ error: `gezel ${gezelId} not found` }, 404);
    }
    // User-initiated — the Klerk call is consented regardless of
    // engagement mode; only config.growth.enabled gates (inside refresh).
    await ctx.growth.refresh(gezelId, { allowKlerk: true });
    return c.json(await buildPayload(ctx, gezelId));
  });

  app.post('/:id/growth/accept', async (c) => {
    const gezelId = c.req.param('id');
    const body = (await c.req.json()) as { proposalId?: string };
    if (!body.proposalId) return c.json({ error: 'missing proposalId' }, 400);

    // The whole read → reward → persist cycle holds the per-gezel growth
    // lock: a concurrent accept (second window) must re-read and see the
    // pending consumed, and a background refresh must not interleave.
    return ctx.growth.runExclusive(gezelId, async () => {
      const state = await ctx.store.readGezelGrowth(gezelId);
      const pending = state.pendingLevelUp;
      if (!pending) return c.json({ error: 'no pending level-up' }, 409);
      const proposal = pending.proposals.find((p) => p.id === body.proposalId);
      if (!proposal) return c.json({ error: `unknown proposal ${body.proposalId}` }, 400);

      const now = new Date().toISOString();
      const next: GezelGrowthState = { ...state };
      let adoptedTraitId: string | undefined;

      try {
        if (proposal.kind === 'trait') {
          const trait: GezelTrait = {
            id: `trait-${proposal.id.replace(/^prop-/, '')}`,
            text: proposal.traitText,
            adoptedAt: now,
            source: 'levelup',
          };
          await ctx.store.addGezelTrait(gezelId, trait);
          adoptedTraitId = trait.id;
          const record: AdoptedTraitRecord = {
            traitId: trait.id,
            text: trait.text,
            level: pending.toLevel,
            adoptedAt: now,
            evidence: proposal.evidence,
          };
          next.adoptedTraits = [...state.adoptedTraits, record];
        } else if (proposal.kind === 'tuning') {
          await applyTuning(ctx, gezelId, proposal, pending.toLevel);
        } else {
          next.unlockedCosmetics = appendUnlock(state.unlockedCosmetics, proposal.cosmeticId, now);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/8 traits/.test(message)) return c.json({ error: message }, 409);
        throw err;
      }

      // Resolve the level-up: level advances, the milestone marker always
      // lands, non-chosen TRAIT proposals are recorded as declined so they
      // are never re-offered.
      next.level = pending.toLevel;
      next.unlockedCosmetics = appendUnlock(
        next.unlockedCosmetics ?? state.unlockedCosmetics,
        `level-${pending.toLevel}`,
        now,
      );
      next.declinedProposals = [
        ...state.declinedProposals,
        ...declineTraits(
          pending.proposals.filter((p) => p.kind === 'trait' && p.id !== proposal.id),
          pending.toLevel,
          now,
        ),
      ];
      delete next.pendingLevelUp;
      try {
        await ctx.store.writeGezelGrowth(gezelId, next);
      } catch (err) {
        // The trait landed in gezel.md before growth.json persisted. Leaving
        // it there with the pending still live invites a second accept and a
        // double payout — roll it back so a failed persist leaves no adopted
        // trait behind.
        if (adoptedTraitId) {
          await ctx.store.removeGezelTrait(gezelId, adoptedTraitId).catch((rollbackErr) => {
            log.warn(
              `[growth] could not roll back trait ${adoptedTraitId} for ${gezelId} after a failed persist:`,
              rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
            );
          });
        }
        throw err;
      }
      return c.json(await buildPayload(ctx, gezelId));
    });
  });

  app.post('/:id/growth/decline', async (c) => {
    const gezelId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { proposalId?: string };

    return ctx.growth.runExclusive(gezelId, async () => {
      const state = await ctx.store.readGezelGrowth(gezelId);
      const pending = state.pendingLevelUp;
      if (!pending) return c.json({ error: 'no pending level-up' }, 409);
      const now = new Date().toISOString();

      if (body.proposalId) {
        const proposal = pending.proposals.find((p) => p.id === body.proposalId);
        if (!proposal) return c.json({ error: `unknown proposal ${body.proposalId}` }, 400);
        if (pending.proposals.length <= 1) {
          return c.json(
            { error: 'cannot decline the last remaining option — skip the level instead' },
            400,
          );
        }
        const next: GezelGrowthState = {
          ...state,
          pendingLevelUp: {
            ...pending,
            proposals: pending.proposals.filter((p) => p.id !== proposal.id),
          },
          declinedProposals: [
            ...state.declinedProposals,
            ...declineTraits([proposal], pending.toLevel, now),
          ],
        };
        await ctx.store.writeGezelGrowth(gezelId, next);
        return c.json(await buildPayload(ctx, gezelId));
      }

      // Skip the whole level: level advances anyway (it was earned), all
      // trait proposals are recorded as declined, the milestone unlocks.
      const next: GezelGrowthState = {
        ...state,
        level: pending.toLevel,
        unlockedCosmetics: appendUnlock(state.unlockedCosmetics, `level-${pending.toLevel}`, now),
        declinedProposals: [
          ...state.declinedProposals,
          ...declineTraits(
            pending.proposals.filter((p) => p.kind === 'trait'),
            pending.toLevel,
            now,
          ),
        ],
      };
      delete next.pendingLevelUp;
      await ctx.store.writeGezelGrowth(gezelId, next);
      return c.json(await buildPayload(ctx, gezelId));
    });
  });

  app.delete('/:id/growth/traits/:traitId', async (c) => {
    const gezelId = c.req.param('id');
    const traitId = c.req.param('traitId');
    return ctx.growth.runExclusive(gezelId, async () => {
      try {
        await ctx.store.removeGezelTrait(gezelId, traitId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/no trait/.test(message)) return c.json({ error: message }, 404);
        throw err;
      }
      const state = await ctx.store.readGezelGrowth(gezelId);
      const next: GezelGrowthState = {
        ...state,
        adoptedTraits: state.adoptedTraits.map((t) =>
          t.traitId === traitId && !t.removedAt ? { ...t, removedAt: new Date().toISOString() } : t,
        ),
      };
      await ctx.store.writeGezelGrowth(gezelId, next);
      return c.json(await buildPayload(ctx, gezelId));
    });
  });

  return app;
}

function appendUnlock(
  unlocked: GezelGrowthState['unlockedCosmetics'],
  id: string,
  at: string,
): GezelGrowthState['unlockedCosmetics'] {
  if (unlocked.some((u) => u.id === id)) return unlocked;
  return [...unlocked, { id, at }];
}

function declineTraits(
  proposals: GrowthProposal[],
  level: number,
  declinedAt: string,
): DeclinedProposalRecord[] {
  return proposals.map((p) => ({
    kind: p.kind,
    title: p.title,
    ...(p.kind === 'trait' ? { traitText: p.traitText } : {}),
    level,
    declinedAt,
  }));
}

/** Apply a tuning payout with clamps; logs `gezel.tuning.adjusted`. */
async function applyTuning(
  ctx: ServiceContext,
  gezelId: string,
  proposal: Extract<GrowthProposal, { kind: 'tuning' }>,
  toLevel: number,
): Promise<void> {
  const gezel = await ctx.store.getGezel(gezelId);
  if (!gezel) throw new Error(`gezel ${gezelId} not found`);
  const fm = gezel.parsed.frontmatter;

  if (proposal.action.type === 'profile') {
    const before = fm.tuningProfile ?? null;
    await ctx.store.updateGezelSettings(gezelId, { tuningProfile: proposal.action.profile });
    await ctx.history.log({
      kind: 'gezel.tuning.adjusted',
      gezelId,
      summary: `${gezel.name} switched tuning profile to ${proposal.action.profile} (level ${toLevel})`,
      details: { before, after: proposal.action.profile, via: 'levelup', toLevel },
    });
    return;
  }

  // Temperature nudge — clamped to ±20% of the current value and the
  // global [0.1, 1.5] envelope, resolved against the CURRENT frontmatter
  // at accept time (not proposal time).
  const base = fm.tuning?.sampling?.temperature ?? 0.7;
  const lo = Math.max(0.1, base * 0.8);
  const hi = Math.min(1.5, base * 1.2);
  const next = Math.round(Math.min(hi, Math.max(lo, base + proposal.action.delta)) * 100) / 100;
  const tuning = {
    ...(fm.tuning ?? {}),
    sampling: { ...(fm.tuning?.sampling ?? {}), temperature: next },
  };
  await ctx.store.updateGezelSettings(gezelId, { tuning });
  await ctx.history.log({
    kind: 'gezel.tuning.adjusted',
    gezelId,
    summary: `${gezel.name} nudged temperature ${base} → ${next} (level ${toLevel})`,
    details: { before: base, after: next, via: 'levelup', toLevel },
  });
}
