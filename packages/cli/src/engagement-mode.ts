import type { AIEngagementMode } from '@bendyline/gezel';

/**
 * Terminal-facing names for Gezel's four engagement postures. The persisted
 * values predate the CLI labels, so this table is the one translation point
 * shared by the one-shot command and the interactive TUI.
 */
export interface CliEngagementModeOption {
  name: 'read-only' | 'reactive' | 'reactive+tasks' | 'full-play';
  mode: AIEngagementMode;
  label: string;
  description: string;
}

export const CLI_ENGAGEMENT_MODES: ReadonlyArray<CliEngagementModeOption> = [
  {
    name: 'read-only',
    mode: 'off',
    label: 'Read-only',
    description: 'AI is paused; browse projects and history without starting AI work.',
  },
  {
    name: 'reactive',
    mode: 'reactive',
    label: 'Reactive',
    description: 'AI replies to messages; autonomous task work stays paused.',
  },
  {
    name: 'reactive+tasks',
    mode: 'scheduled',
    label: 'Reactive + tasks',
    description: 'Messages, task work, and schedules run without proactive nudges.',
  },
  {
    name: 'full-play',
    mode: 'proactive',
    label: 'Full play',
    description: 'Everything runs, including proactive nudges and cross-gezel work.',
  },
];

const MODE_ALIASES: Readonly<Record<string, AIEngagementMode>> = {
  'read-only': 'off',
  readonly: 'off',
  off: 'off',
  reactive: 'reactive',
  'reactive-only': 'reactive',
  'reactive+tasks': 'scheduled',
  'tasks+reactive': 'scheduled',
  scheduled: 'scheduled',
  'full-play': 'proactive',
  fullplay: 'proactive',
  proactive: 'proactive',
};

/** Accept canonical CLI names plus the persisted/UI names for discoverability. */
export function parseCliEngagementMode(input: string): AIEngagementMode | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/\s*\+\s*/g, '+')
    .replace(/[\s_]+/g, '-');
  return MODE_ALIASES[normalized] ?? null;
}

export function cliEngagementModeOption(
  mode: AIEngagementMode | null | undefined,
): CliEngagementModeOption {
  return CLI_ENGAGEMENT_MODES.find((option) => option.mode === (mode ?? 'proactive'))!;
}

export const CLI_ENGAGEMENT_MODE_USAGE = CLI_ENGAGEMENT_MODES.map((option) => option.name).join(
  '|',
);
