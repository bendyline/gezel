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
    description: 'Your crew answers when you ask. Tasks and schedules wait until you switch back.',
  },
  {
    mode: 'scheduled',
    label: 'Tasks + chat',
    description:
      'Your crew works through tasks and schedules and answers you in chat. Nobody starts anything unasked.',
  },
  {
    mode: 'proactive',
    label: 'Proactive',
    description:
      'Your crew also takes initiative: members start work, check in on projects, and hand work to each other.',
  },
];
