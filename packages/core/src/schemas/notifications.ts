import { z } from 'zod';

/** At most this many notifications a day by default; the person can change it. */
export const DEFAULT_NOTIFICATION_DAILY_CAP = 3;
export const NOTIFICATION_DAILY_CAP_MAX = 10;

/** `config.notifications`: how many earned notifications a day may reach the person. */
export const NotificationsConfigSchema = z.object({
  /** 0 turns earned notifications off. Absent = `DEFAULT_NOTIFICATION_DAILY_CAP`. */
  dailyCap: z.number().int().min(0).max(NOTIFICATION_DAILY_CAP_MAX).optional(),
});
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

export const REMINDER_TITLE_MAX = 80;
export const REMINDER_BODY_MAX = 160;
/** A script may not set a reminder further out than this. */
export const REMINDER_MAX_AHEAD_DAYS = 30;

/**
 * A project's one reminder: a time its own scripts computed from its own
 * state (the flashcards' next due card), never a time picked for its own
 * sake. Stored at `projects/<id>/reminder.json`; setting a new one replaces it.
 */
export const ProjectReminderSchema = z.object({
  projectId: z.string(),
  at: z.string(),
  title: z.string().min(1).max(REMINDER_TITLE_MAX),
  body: z.string().max(REMINDER_BODY_MAX).optional(),
  /** The script that set it, so a person can see where it came from. */
  source: z.string().optional(),
  setAt: z.string(),
});
export type ProjectReminder = z.infer<typeof ProjectReminderSchema>;

export const ListRemindersResponseSchema = z.object({
  reminders: z.array(ProjectReminderSchema.extend({ projectName: z.string().optional() })),
});
export type ListRemindersResponse = z.infer<typeof ListRemindersResponseSchema>;
