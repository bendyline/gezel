import type { GezelConfig } from './schemas/api.js';

export type AIEngagementMode = 'proactive' | 'scheduled' | 'reactive' | 'off';

export function getEngagementMode(cfg: Pick<GezelConfig, 'aiEngagementMode'>): AIEngagementMode {
  return cfg.aiEngagementMode ?? 'proactive';
}

export function isProactiveAllowed(cfg: Pick<GezelConfig, 'aiEngagementMode'>): boolean {
  return getEngagementMode(cfg) === 'proactive';
}

/** Whether autonomous work on active tasks may start or advance. */
export function isTaskWorkAllowed(cfg: Pick<GezelConfig, 'aiEngagementMode'>): boolean {
  const m = getEngagementMode(cfg);
  return m === 'proactive' || m === 'scheduled';
}

export function isSchedulingAllowed(cfg: Pick<GezelConfig, 'aiEngagementMode'>): boolean {
  return isTaskWorkAllowed(cfg);
}

export function isEngagementAllowed(cfg: Pick<GezelConfig, 'aiEngagementMode'>): boolean {
  return getEngagementMode(cfg) !== 'off';
}

export type WorkshopTempo = 'gezellig' | 'bedrijvig' | 'druk' | 'dolle-boel';

export function getWorkshopTempo(cfg: Pick<GezelConfig, 'workshopTempo'>): WorkshopTempo {
  return cfg.workshopTempo ?? 'bedrijvig';
}

export interface WorkshopTempoDefaults {
  rapidIntervalMs: number;
  slowIntervalMs: number;
  recentActivityWindowMs: number;
  rapidAttemptsBeforeBackoff: number;
  /**
   * Grace period applied to the very first nudge a project ever
   * receives, measured from `project.createdAt`. Once the project
   * has been nudged at least once this guard no longer applies and
   * the rapid/slow cadence takes over.
   *
   * Without this, a freshly-kicked-off project gets pinged at the
   * 5-minute mark exactly when the voorman is most likely deep in
   * the first task and least likely to benefit from a "checking in"
   * interruption. Tempo-specific so the laid-back `gezellig` mode
   * gives lots of warm-up room while `dolle-boel` barely waits.
   */
  firstNudgeGraceMs: number;
}

export function workshopTempoDefaults(tempo: WorkshopTempo): WorkshopTempoDefaults {
  switch (tempo) {
    case 'gezellig':
      return {
        rapidIntervalMs: 30 * 60_000,
        slowIntervalMs: 12 * 60 * 60_000,
        recentActivityWindowMs: 90 * 60_000,
        rapidAttemptsBeforeBackoff: 2,
        firstNudgeGraceMs: 2 * 60 * 60_000,
      };
    case 'druk':
      return {
        rapidIntervalMs: 2 * 60_000,
        slowIntervalMs: 60 * 60_000,
        recentActivityWindowMs: 45 * 60_000,
        rapidAttemptsBeforeBackoff: 5,
        firstNudgeGraceMs: 10 * 60_000,
      };
    case 'dolle-boel':
      return {
        rapidIntervalMs: 45_000,
        slowIntervalMs: 20 * 60_000,
        recentActivityWindowMs: 30 * 60_000,
        rapidAttemptsBeforeBackoff: 8,
        firstNudgeGraceMs: 2 * 60_000,
      };
    default:
      return {
        rapidIntervalMs: 5 * 60_000,
        slowIntervalMs: 6 * 60 * 60_000,
        recentActivityWindowMs: 60 * 60_000,
        rapidAttemptsBeforeBackoff: 3,
        // Lowered from 30 min — evals (and short-lived chat sessions
        // generally) were timing out before the scheduler got a
        // single chance to nudge a stalled Voorman. 10 min is still a
        // polite grace for fresh projects: the user has minutes to
        // settle in before the autopilot prods anyone. Aligns with
        // the `druk` tempo's grace so both deliberate-cadence modes
        // converge.
        firstNudgeGraceMs: 10 * 60_000,
      };
  }
}
