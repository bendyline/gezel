import type { GezmodelEngine } from '@bendyline/gezel';

export const MODEL_INVENTORY_CHANGED_EVENT = 'gezel:models-changed';

const revisions = new Map<GezmodelEngine, number>();

/**
 * Announce that an installed native-model inventory changed. Consumers use
 * the monotonically increasing revision to discard page-lifetime caches and
 * force the user daemon to refresh its view of the machine broker.
 */
export function announceModelInventoryChanged(engine: GezmodelEngine): void {
  revisions.set(engine, (revisions.get(engine) ?? 0) + 1);
  window.dispatchEvent(new CustomEvent(MODEL_INVENTORY_CHANGED_EVENT, { detail: { engine } }));
}

export function modelInventoryRevision(engine: GezmodelEngine): number {
  return revisions.get(engine) ?? 0;
}

export function changedModelInventoryEngine(event: Event): GezmodelEngine | null {
  const engine = (event as CustomEvent<{ engine?: unknown }>).detail?.engine;
  return engine === 'llama-cpp' || engine === 'mlx' || engine === 'ds4' ? engine : null;
}
