/**
 * Growth API — character sheet + the level-up consent loop. Every
 * mutation re-reads growth.json and verifies the pending/proposal before
 * acting (double-accept from a second window 409s), and every mutating
 * response returns the full refreshed payload so the UI swaps state in
 * atomically.
 */

import {
  type GezelGrowthResponse,
  type GezelTrait,
  type GrowthProposal,
  acceptedGrowthState,
  createLogger,
  declinedGrowthState,
  growthResponse,
  levelUpTrait,
  nudgedTemperatureTuning,
  pendingProposal,
  retiredTraitState,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

const log = createLogger('growth');

/** Re-fire a background signals refresh when the sheet is older than this. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

async function buildPayload(ctx: ServiceContext, gezelId: string): Promise<GezelGrowthResponse> {
  const state = await ctx.store.readGezelGrowth(gezelId);
  const gezel = await ctx.store.getGezel(gezelId).catch(() => null);
  return growthResponse(state, gezel?.parsed.frontmatter.traits ?? []);
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
      const found = pendingProposal(state, body.proposalId);
      if (!found.ok) return c.json({ error: found.error }, found.status);
      const { pending, proposal } = found.value;
      const now = new Date().toISOString();
      let adopted: GezelTrait | undefined;

      try {
        if (proposal.kind === 'trait') {
          adopted = levelUpTrait(proposal, now);
          await ctx.store.addGezelTrait(gezelId, adopted);
        } else if (proposal.kind === 'tuning') {
          await applyTuning(ctx, gezelId, proposal, pending.toLevel);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/8 traits/.test(message)) return c.json({ error: message }, 409);
        throw err;
      }

      const next = acceptedGrowthState(state, pending, proposal, now, adopted);
      try {
        await ctx.store.writeGezelGrowth(gezelId, next);
      } catch (err) {
        // The trait landed in gezel.md before growth.json persisted. Leaving
        // it there with the pending still live invites a second accept and a
        // double payout — roll it back so a failed persist leaves no adopted
        // trait behind.
        if (adopted) {
          const traitId = adopted.id;
          await ctx.store.removeGezelTrait(gezelId, traitId).catch((rollbackErr) => {
            log.warn(
              `[growth] could not roll back trait ${traitId} for ${gezelId} after a failed persist:`,
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
      const next = declinedGrowthState(state, body.proposalId, new Date().toISOString());
      if (!next.ok) return c.json({ error: next.error }, next.status);
      await ctx.store.writeGezelGrowth(gezelId, next.value);
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
      await ctx.store.writeGezelGrowth(
        gezelId,
        retiredTraitState(state, traitId, new Date().toISOString()),
      );
      return c.json(await buildPayload(ctx, gezelId));
    });
  });

  return app;
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

  const {
    tuning,
    before: base,
    after: next,
  } = nudgedTemperatureTuning(fm.tuning, proposal.action.delta);
  await ctx.store.updateGezelSettings(gezelId, { tuning });
  await ctx.history.log({
    kind: 'gezel.tuning.adjusted',
    gezelId,
    summary: `${gezel.name} nudged temperature ${base} → ${next} (level ${toLevel})`,
    details: { before: base, after: next, via: 'levelup', toLevel },
  });
}
