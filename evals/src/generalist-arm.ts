/**
 * Human label for a trial's generalist-mode arm. The daemon setting is
 * `on` / `off` / `auto`; the reports speak of the execution mode it selects
 * (`generalist` / `stepwise`), and a trial that predates the switch has no
 * arm at all, so every roll-up that keys rows by model must key by this too
 * or an A/B root collapses both arms into one row.
 */
export function generalistArmLabel(mode: string | null | undefined): string | undefined {
  if (!mode) return undefined;
  if (mode === 'on') return 'generalist';
  if (mode === 'off') return 'stepwise';
  return mode;
}
