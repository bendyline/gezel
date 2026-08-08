import { z } from 'zod';

/**
 * Live gilde content updates — the opt-in mechanism that lets the daemon
 * fetch newer `@bendyline/gilde` patch releases (same minor line as the
 * bundled pin) from the npm registry and serve them as the catalog content
 * root without a restart. These are the wire shapes for
 * `GET /api/gilde-updates` and the per-check result recorded in
 * `~/.gezel/gilde/state.json`.
 */

export const GildeUpdateCheckOutcomeSchema = z.enum([
  /** Registry consulted; no newer patch on the pinned minor line. */
  'up-to-date',
  /** A newer release was fetched, validated, and activated. */
  'updated',
  /**
   * A newer release exists but failed the no-regression validation gate
   * (items resolvable today would vanish under the candidate). Current
   * content stays active; the fix ships with an app update.
   */
  'incompatible',
  /** Network / registry / staging failure. Current content stays active. */
  'error',
  /**
   * The check was refused before touching the network: updates disabled,
   * `GEZEL_GILDE_DATA_DIR` override active, or auto-update network access
   * denied by the security policy (super-lockdown). `message` carries which.
   */
  'blocked',
]);
export type GildeUpdateCheckOutcome = z.infer<typeof GildeUpdateCheckOutcomeSchema>;

export const GildeUpdateCheckResultSchema = z.object({
  /** ISO timestamp of when the check finished. */
  at: z.string(),
  outcome: GildeUpdateCheckOutcomeSchema,
  /** Human-readable detail for `error` / `blocked` / `incompatible`. */
  message: z.string().optional(),
  /** The candidate version the check landed on, when one was found. */
  version: z.string().optional(),
  /** Item ids that would stop resolving, for `incompatible` (capped). */
  regressions: z
    .array(z.object({ kind: z.string(), id: z.string() }))
    .max(25)
    .optional(),
});
export type GildeUpdateCheckResult = z.infer<typeof GildeUpdateCheckResultSchema>;

export const GildeUpdateStatusResponseSchema = z.object({
  /** The `config.gildeUpdates.enabled` opt-in flag. */
  enabled: z.boolean(),
  /**
   * Where catalog content is served from: the bundled pin, an activated
   * live version, or a `GEZEL_GILDE_DATA_DIR` override (dev/evals) that
   * disables the whole mechanism.
   */
  mode: z.enum(['bundled', 'live', 'overridden']),
  /** Version of the `@bendyline/gilde` package this build shipped with. */
  bundledVersion: z.string(),
  /** Activated live version, or null when serving bundled content. */
  activeVersion: z.string().nullable(),
  lastCheck: GildeUpdateCheckResultSchema.nullable(),
  updateInProgress: z.boolean(),
});
export type GildeUpdateStatusResponse = z.infer<typeof GildeUpdateStatusResponseSchema>;
