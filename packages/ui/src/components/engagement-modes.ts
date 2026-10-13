import type { AIEngagementMode } from '@bendyline/gezel';

/**
 * Ordered from paused to most independent, so a tray reads left to right as
 * the crew coming to the bench. Shared by the titlebar menu and Settings.
 */
export const ENGAGEMENT_MODES: {
  mode: AIEngagementMode;
  label: string;
  description: string;
}[] = [
  {
    mode: 'off',
    label: 'Off',
    description:
      'Everything is paused, even chat. A reply already underway can finish; queued messages are canceled.',
  },
  {
    mode: 'reactive',
    label: 'Chat only',
    description:
      'Your gezellen answer when you ask. Tasks and schedules wait until you switch back.',
  },
  {
    mode: 'scheduled',
    label: 'Tasks + chat',
    description:
      'Your gezellen work through tasks and schedules and answer you in chat. Nobody starts anything unasked.',
  },
  {
    mode: 'proactive',
    label: 'Proactive',
    description:
      'Your gezellen also take initiative: they start work, check in on projects, and hand work to each other.',
  },
];
