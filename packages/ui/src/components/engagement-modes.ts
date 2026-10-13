import type { AIEngagementMode } from '@bendyline/gezel';

/** Ordered from most independent to paused; shared by the menu and Settings. */
export const ENGAGEMENT_MODES: {
  mode: AIEngagementMode;
  label: string;
  hint: string;
  description: string;
}[] = [
  {
    mode: 'proactive',
    label: 'Proactive',
    hint: 'Gezels take initiative, work together, and keep tasks moving.',
    description:
      'Your crew can take initiative and work together. Chat, tasks, schedules, proactive check-ins, and messages between gezels are all enabled.',
  },
  {
    mode: 'scheduled',
    label: 'Tasks + chat',
    hint: 'Gezels carry out tasks and schedules, and answer you in chat.',
    description:
      'Your crew carries out active tasks and schedules, and answers you in chat. Proactive check-ins and messages between gezels are paused.',
  },
  {
    mode: 'reactive',
    label: 'Chat only',
    hint: 'Gezels answer when you ask. Task work is paused.',
    description:
      'Your crew responds to your direct messages. New task steps, scheduled jobs, proactive check-ins, and messages between gezels are paused. An in-flight turn can finish.',
  },
  {
    mode: 'off',
    label: 'Off',
    hint: 'The whole crew is paused, including chat.',
    description:
      'Chat and all background AI activity are paused. An in-flight turn can finish; queued messages are canceled.',
  },
];
