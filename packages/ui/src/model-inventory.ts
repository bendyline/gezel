import type { GezmodelEngine } from '@bendyline/gezel';

export const MODEL_INVENTORY_CHANGED_EVENT = 'gezel:models-changed';

/** Every inventory the event can announce: the native model engines plus knowledge catalogs. */
export type InventoryKey = GezmodelEngine | 'knowledge';

const revisions = new Map<InventoryKey, number>();

/**
 * Announce that an installed inventory changed — a native-model engine's
 * models or the user's knowledge catalogs. Consumers use the monotonically
 * increasing revision to discard page-lifetime caches and force the user
 * daemon to refresh its view of the machine broker.
 */
export function announceInventoryChanged(key: InventoryKey): void {
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  window.dispatchEvent(new CustomEvent(MODEL_INVENTORY_CHANGED_EVENT, { detail: { engine: key } }));
}

export function announceModelInventoryChanged(engine: GezmodelEngine): void {
  announceInventoryChanged(engine);
}

export function modelInventoryRevision(engine: InventoryKey): number {
  return revisions.get(engine) ?? 0;
}

export function changedInventoryKey(event: Event): InventoryKey | null {
  const engine = (event as CustomEvent<{ engine?: unknown }>).detail?.engine;
  return engine === 'llama-cpp' || engine === 'mlx' || engine === 'ds4' || engine === 'knowledge'
    ? engine
    : null;
}

/** The native engine an event names, or null for a non-engine inventory (knowledge). */
export function changedModelInventoryEngine(event: Event): GezmodelEngine | null {
  const key = changedInventoryKey(event);
  return key === null || key === 'knowledge' ? null : key;
}
