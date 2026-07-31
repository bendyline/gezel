import type { CreateTaskRequest } from '@bendyline/gezel';

/**
 * Shared recipe pieces for recurring spawn-host tasks ("schedule hosts"),
 * used by both project-type adoption (`project-type/apply.ts`) and the
 * suggested-work enable flow (`suggested-work/enable.ts`).
 *
 * A `night-shift` host is the same cron spawn host with the night flags
 * on: the cron below is a mere heartbeat — the scheduler only spawns
 * while the Night Shift window is open, and `onceADay` caps it at one
 * spawn per window (stamped at spawn time). Cadence therefore follows
 * the user's local window, never the UTC cron, which sidesteps the
 * UTC-cron-vs-local-window mismatch entirely.
 */
export const NIGHT_SHIFT_HEARTBEAT_CRON = '*/30 * * * *';

export const SCHEDULE_HOST_STEP = {
  name: 'Wait for schedule',
  prompt:
    'This host task holds a recurring schedule. It never runs its own steps — each fire spawns a child task from the attached craftbook.',
} as const;

export type HostRunMode = 'scheduled' | 'night-shift';

/**
 * The recurrence fields for a host create request. For `scheduled`,
 * `cron` is required and used verbatim; for `night-shift`, the heartbeat
 * is used and the night flags are set.
 */
export function hostRecurrenceFields(args: {
  runMode: HostRunMode;
  cron?: string;
  overlap?: 'skip' | 'queue' | 'concurrent';
}): Pick<CreateTaskRequest, 'cron' | 'nightShift'> {
  if (args.runMode === 'night-shift') {
    return {
      cron: {
        expression: NIGHT_SHIFT_HEARTBEAT_CRON,
        overlap: args.overlap ?? 'skip',
      },
      nightShift: { enabled: true, onceADay: true },
    };
  }
  if (!args.cron) throw new Error('scheduled hosts require a cron expression');
  return {
    cron: {
      expression: args.cron,
      ...(args.overlap ? { overlap: args.overlap } : {}),
    },
  };
}

/** The cron expression a host actually carries (heartbeat for night-shift). */
export function hostCronExpression(args: { runMode: HostRunMode; cron?: string }): string {
  if (args.runMode === 'night-shift') return NIGHT_SHIFT_HEARTBEAT_CRON;
  if (!args.cron) throw new Error('scheduled hosts require a cron expression');
  return args.cron;
}

/** Human description of the host's cadence for task descriptions and cards. */
export function describeHostCadence(args: { runMode: HostRunMode; cron?: string }): string {
  return args.runMode === 'night-shift'
    ? 'Runs during the Night Shift window, at most once per night.'
    : `Cron (UTC): ${args.cron}.`;
}
