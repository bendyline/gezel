/**
 * When a turn's local model has to replace a busy one, the swap happens at
 * that engine's next idle moment — the end of the turn it is running —
 * rather than failing after the pool's short bounded drain.
 *
 * A turn that waits for a swap also steps aside for one: a turn bound to an
 * engine another request is waiting to unload rejects before it starts,
 * rebinds, and runs once that swap is done. Two kinds of turn do neither and
 * keep the pool's bounded drain:
 *
 * - a consultation the asker's turn is blocked on. Waiting for the asker's
 *   engine to go idle, or stepping aside so it can, would wait forever.
 * - ambient chores. They must not line a model swap up behind the person's
 *   turn, and are not worth cutting short for one.
 */
export function turnWaitsForEngineSwap(
  opts: { ambient?: boolean } | undefined,
  isAskTarget: boolean,
): boolean {
  return opts?.ambient !== true && !isAskTarget;
}

/**
 * How many times one send may step aside for a swap before it fails. Each
 * step waits a whole turn of the other model, so reaching this means the
 * engine changed hands that many times in the moment between this turn
 * getting its model back and starting on it.
 */
export const MAX_ENGINE_REBINDS_PER_SEND = 8;

/** Status line while a turn waits for another model's turn to finish. */
export function engineSwapWaitLabel(holderNames: readonly string[]): string {
  if (holderNames.length === 0) {
    return 'Waiting for the current work to finish before switching models';
  }
  const last = holderNames[holderNames.length - 1];
  const who =
    holderNames.length === 1 ? last : `${holderNames.slice(0, -1).join(', ')} and ${last}`;
  return `Waiting for ${who} to finish before switching models`;
}
