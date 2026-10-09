/**
 * The level-up consent loop as pure state transitions, shared by the
 * desktop's growth routes and the phone's: which proposal an accept names,
 * what the state becomes once its payout has landed, what declining or
 * skipping does, and the clamped temperature nudge. Hosts own the writes
 * (the trait into gezel.md, the tuning into frontmatter, growth.json).
 */

import type { GezelGrowthResponse } from '../schemas/api.js';
import type { GezelTrait } from '../schemas/gezel.js';
import {
  type AdoptedTraitRecord,
  type DeclinedProposalRecord,
  type GezelGrowthState,
  type GrowthProposal,
  type PendingLevelUp,
  xpForLevel,
} from '../schemas/growth.js';
import type { ChatModelTuning } from '../schemas/model-tuning.js';

export type GrowthStep<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 409; error: string };

/** What every growth route answers with, so the UI swaps state in atomically. */
export function growthResponse(
  state: GezelGrowthState,
  activeTraits: readonly GezelTrait[],
): GezelGrowthResponse {
  const activeIds = new Set(activeTraits.map((t) => t.id));
  return {
    state,
    nextLevelXp: xpForLevel(state.level + 1),
    activeTraits: [...activeTraits],
    driftedTraitIds: state.adoptedTraits
      .filter((t) => !t.removedAt && !activeIds.has(t.traitId))
      .map((t) => t.traitId),
  };
}

/** The pending level-up and the proposal an accept names, or why there is none. */
export function pendingProposal(
  state: GezelGrowthState,
  proposalId: string | undefined,
): GrowthStep<{ pending: PendingLevelUp; proposal: GrowthProposal }> {
  if (!proposalId) return { ok: false, status: 400, error: 'missing proposalId' };
  const pending = state.pendingLevelUp;
  if (!pending) return { ok: false, status: 409, error: 'no pending level-up' };
  const proposal = pending.proposals.find((p) => p.id === proposalId);
  if (!proposal) return { ok: false, status: 400, error: `unknown proposal ${proposalId}` };
  return { ok: true, value: { pending, proposal } };
}

/** The trait an accepted trait proposal adds to gezel.md. */
export function levelUpTrait(
  proposal: Extract<GrowthProposal, { kind: 'trait' }>,
  now: string,
): GezelTrait {
  return {
    id: `trait-${proposal.id.replace(/^prop-/, '')}`,
    text: proposal.traitText,
    adoptedAt: now,
    source: 'levelup',
  };
}

export function appendGrowthUnlock(
  unlocked: GezelGrowthState['unlockedCosmetics'],
  id: string,
  at: string,
): GezelGrowthState['unlockedCosmetics'] {
  if (unlocked.some((u) => u.id === id)) return unlocked;
  return [...unlocked, { id, at }];
}

function declined(
  proposals: readonly GrowthProposal[],
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

/**
 * The state once an accepted proposal's payout has landed: the level
 * advances, the milestone marker always unlocks, a trait is recorded as
 * adopted, a cosmetic as unlocked, and the trait proposals not chosen are
 * recorded as declined so they are never offered again.
 */
export function acceptedGrowthState(
  state: GezelGrowthState,
  pending: PendingLevelUp,
  proposal: GrowthProposal,
  now: string,
  adoptedTrait?: GezelTrait,
): GezelGrowthState {
  const next: GezelGrowthState = { ...state };
  if (proposal.kind === 'trait' && adoptedTrait) {
    const record: AdoptedTraitRecord = {
      traitId: adoptedTrait.id,
      text: adoptedTrait.text,
      level: pending.toLevel,
      adoptedAt: now,
      evidence: proposal.evidence,
    };
    next.adoptedTraits = [...state.adoptedTraits, record];
  } else if (proposal.kind === 'cosmetic') {
    next.unlockedCosmetics = appendGrowthUnlock(state.unlockedCosmetics, proposal.cosmeticId, now);
  }
  next.level = pending.toLevel;
  next.unlockedCosmetics = appendGrowthUnlock(
    next.unlockedCosmetics,
    `level-${pending.toLevel}`,
    now,
  );
  next.declinedProposals = [
    ...state.declinedProposals,
    ...declined(
      pending.proposals.filter((p) => p.kind === 'trait' && p.id !== proposal.id),
      pending.toLevel,
      now,
    ),
  ];
  delete next.pendingLevelUp;
  return next;
}

/**
 * Decline one option (it leaves the menu), or with no id skip the level:
 * the level still advances (it was earned), every trait on offer is
 * recorded as declined, and the milestone unlocks.
 */
export function declinedGrowthState(
  state: GezelGrowthState,
  proposalId: string | undefined,
  now: string,
): GrowthStep<GezelGrowthState> {
  const pending = state.pendingLevelUp;
  if (!pending) return { ok: false, status: 409, error: 'no pending level-up' };
  if (proposalId) {
    const proposal = pending.proposals.find((p) => p.id === proposalId);
    if (!proposal) return { ok: false, status: 400, error: `unknown proposal ${proposalId}` };
    if (pending.proposals.length <= 1) {
      return {
        ok: false,
        status: 400,
        error: 'cannot decline the last remaining option — skip the level instead',
      };
    }
    return {
      ok: true,
      value: {
        ...state,
        pendingLevelUp: {
          ...pending,
          proposals: pending.proposals.filter((p) => p.id !== proposal.id),
        },
        declinedProposals: [
          ...state.declinedProposals,
          ...declined([proposal], pending.toLevel, now),
        ],
      },
    };
  }
  const next: GezelGrowthState = {
    ...state,
    level: pending.toLevel,
    unlockedCosmetics: appendGrowthUnlock(state.unlockedCosmetics, `level-${pending.toLevel}`, now),
    declinedProposals: [
      ...state.declinedProposals,
      ...declined(
        pending.proposals.filter((p) => p.kind === 'trait'),
        pending.toLevel,
        now,
      ),
    ],
  };
  delete next.pendingLevelUp;
  return { ok: true, value: next };
}

/** Stamp a retired trait in the adoption log (gezel.md is the host's to edit). */
export function retiredTraitState(
  state: GezelGrowthState,
  traitId: string,
  now: string,
): GezelGrowthState {
  return {
    ...state,
    adoptedTraits: state.adoptedTraits.map((t) =>
      t.traitId === traitId && !t.removedAt ? { ...t, removedAt: now } : t,
    ),
  };
}

/**
 * A temperature payout, clamped to ±20% of the current value and the
 * [0.1, 1.5] envelope, resolved against the tuning as it stands at accept
 * time rather than when the proposal was made.
 */
export function nudgedTemperatureTuning(
  tuning: ChatModelTuning | undefined,
  delta: number,
): { tuning: ChatModelTuning; before: number; after: number } {
  const before = tuning?.sampling?.temperature ?? 0.7;
  const lo = Math.max(0.1, before * 0.8);
  const hi = Math.min(1.5, before * 1.2);
  const after = Math.round(Math.min(hi, Math.max(lo, before + delta)) * 100) / 100;
  return {
    tuning: { ...(tuning ?? {}), sampling: { ...(tuning?.sampling ?? {}), temperature: after } },
    before,
    after,
  };
}
