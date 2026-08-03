/**
 * Capability-floor model routing — pick the cheapest installed local
 * model that clears a craftbook step's floor. "27B plans and repairs,
 * 4B executes, gates verify": small models execute well-scoped steps
 * fine; per-step routing is what makes a heterogeneous local fleet pay
 * off. See docs/model-fitness.md and docs/local-model-strategy-2026-07.md §4-C.
 *
 * Pure module: no I/O, no logging. ChatManager assembles the
 * candidates/evidence and applies the decision at session build
 * (`resolveRoutedModelForHandoff`); the TaskRunner derives the floor at
 * dispatch. Everything here is unit-tested with fake inputs.
 *
 * Evidence is ADVISORY, never load-bearing:
 * - A fresh fitness record that says `probed` + not admitted (or a
 *   measured decode rate below the floor) removes a candidate; a
 *   missing, stale, `failed`, `deferred`, or `blocked` record removes
 *   nothing.
 * - Gate history DEMOTES (stable-partitions to the back), never
 *   excludes — the only clearing candidate still gets picked even
 *   with an ugly record.
 *
 * Ordering within the floor-clearing set:
 *   tier ascending (cheapest tier that clears IS the goal)
 *   → config default first (one deliberate deviation from literal
 *     cheapest: within the qualifying tier the user's default wins —
 *     a strict parameterSize sort would swap a user's 27B default for
 *     a 20B on every medium step, second-guessing a same-tier choice
 *     and forcing a third resident engine; flipping to strict-cheapest
 *     is this one comparator line)
 *   → already-resident first (avoid eviction thrash / cold spawns)
 *   → parameterSize ascending (nulls last) → residentBytes ascending
 *   → modelId (stable).
 */

import { type ModelTier, tierAtLeast, tierRank } from '@bendyline/gezel';
import type { ResolvedModelFitness } from '../fitness/manager.js';
import type { LocalProviderName } from '../providers/native/engine-key.js';

export interface RoutingCandidate {
  provider: LocalProviderName;
  modelId: string;
  tier: ModelTier;
  /** Parsed parameter count in billions (from catalog `parameterSize`). */
  parameterSizeB?: number;
  residentBytes?: number;
  /** This model is `config.defaultModel[provider]`. */
  isDefault?: boolean;
  /** A replica of this model is resident in the engine pool right now. */
  isResident?: boolean;
}

export interface ModelFitnessEvidence {
  status: 'probed' | 'failed' | 'deferred' | 'blocked';
  admitted: boolean;
  genTokensPerSec?: number | null;
  stale: boolean;
}

export type FitnessLookup = (provider: string, modelId: string) => ModelFitnessEvidence | undefined;

export interface ModelGateEvidence {
  attempts: number;
  approves: number;
  holds: number;
  pauses: number;
}

export type GateEvidenceLookup = (
  provider: string,
  modelId: string,
) => ModelGateEvidence | undefined;

export interface RoutedModelDecision {
  provider: LocalProviderName;
  model: string;
  tier: ModelTier;
  /** Human-readable rationale — logged and stamped on the history event. */
  reason: string;
}

/** Mirrors the fitness probe's throughput floor (checks.ts). */
export const MIN_ROUTING_GEN_TPS = 3;

/** Kill switch — same shape as GEZEL_DISABLE_GATE_ESCALATION. */
export function modelRoutingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GEZEL_DISABLE_MODEL_ROUTING === '1';
}

/** Adapt C1's resolved fitness records into the ranker's lookup. */
export function fitnessLookupFromRecords(
  records: Array<ResolvedModelFitness & { key?: string }>,
): FitnessLookup {
  const map = new Map<string, ModelFitnessEvidence>();
  for (const r of records) {
    map.set(`${r.record.provider}:${r.record.modelId}`, {
      status: r.record.status,
      admitted: r.record.admitted,
      genTokensPerSec: r.record.genTokensPerSec,
      stale: r.stale,
    });
  }
  return (provider, modelId) => map.get(`${provider}:${modelId}`);
}

/**
 * A candidate is dropped only on FRESH, COMPLETED negative evidence:
 * the proeve ran to a verdict (`probed`), the weights haven't changed
 * since (`!stale`), and either the checks failed or the measured
 * decode rate is under the floor.
 */
function fitnessRejects(evidence: ModelFitnessEvidence | undefined): boolean {
  if (!evidence || evidence.stale || evidence.status !== 'probed') return false;
  if (!evidence.admitted) return true;
  return evidence.genTokensPerSec != null && evidence.genTokensPerSec < MIN_ROUTING_GEN_TPS;
}

/**
 * Demotion, not exclusion: repeated gate pauses (the escalation ladder
 * gave up) or a meaningful attempt count with zero approvals. Raw
 * hold-rate is deliberately NOT a signal — every legitimate repair
 * loop logs holds.
 */
function gateEvidenceDemotes(evidence: ModelGateEvidence | undefined): boolean {
  if (!evidence) return false;
  return evidence.pauses >= 2 || (evidence.attempts >= 6 && evidence.approves === 0);
}

export function rankModelForFloor(args: {
  floor: ModelTier;
  candidates: RoutingCandidate[];
  fitness?: FitnessLookup;
  gateEvidence?: GateEvidenceLookup;
}): RoutedModelDecision | null {
  const clearing = args.candidates.filter((c) => tierAtLeast(c.tier, args.floor));
  const fit = clearing.filter((c) => !fitnessRejects(args.fitness?.(c.provider, c.modelId)));
  if (fit.length === 0) return null;

  const kept: RoutingCandidate[] = [];
  const demoted: RoutingCandidate[] = [];
  for (const c of fit) {
    (gateEvidenceDemotes(args.gateEvidence?.(c.provider, c.modelId)) ? demoted : kept).push(c);
  }

  const byCheapest = (a: RoutingCandidate, b: RoutingCandidate): number => {
    if (tierRank(a.tier) !== tierRank(b.tier)) return tierRank(a.tier) - tierRank(b.tier);
    if ((a.isDefault ? 1 : 0) !== (b.isDefault ? 1 : 0)) return a.isDefault ? -1 : 1;
    if ((a.isResident ? 1 : 0) !== (b.isResident ? 1 : 0)) return a.isResident ? -1 : 1;
    const aSize = a.parameterSizeB ?? Number.POSITIVE_INFINITY;
    const bSize = b.parameterSizeB ?? Number.POSITIVE_INFINITY;
    if (aSize !== bSize) return aSize - bSize;
    const aBytes = a.residentBytes ?? Number.POSITIVE_INFINITY;
    const bBytes = b.residentBytes ?? Number.POSITIVE_INFINITY;
    if (aBytes !== bBytes) return aBytes - bBytes;
    return a.modelId.localeCompare(b.modelId);
  };
  kept.sort(byCheapest);
  demoted.sort(byCheapest);
  const pick = kept[0] ?? demoted[0];
  if (!pick) return null;

  const notes: string[] = [`floor=${args.floor}`, `cheapest clearing tier=${pick.tier}`];
  if (pick.isDefault) notes.push('default');
  if (pick.isResident) notes.push('resident');
  if (!kept.includes(pick)) notes.push('demoted-by-gate-history (only clearing candidate)');
  return {
    provider: pick.provider,
    model: pick.modelId,
    tier: pick.tier,
    reason: notes.join('; '),
  };
}
