import { type ProjectReminder, ProjectReminderSchema } from '../schemas/notifications.js';
import { listProjects, projectRoot, requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';

/** A project's one reminder on the phone: `projects/<id>/reminder.json`, as on the desktop. */
export function reminderPath(projectId: string): string {
  return `${projectRoot(projectId)}/reminder.json`;
}

export async function getProjectReminder(
  repo: PortableRepository,
  projectId: string,
): Promise<ProjectReminder | null> {
  return repo.tolerantRecord(
    reminderPath(projectId),
    ProjectReminderSchema,
    `reminder for ${projectId}`,
  );
}

/** Set (replacing any earlier one) or clear a project's reminder. */
export async function setProjectReminder(
  repo: PortableRepository,
  projectId: string,
  reminder: ProjectReminder | null,
): Promise<void> {
  await requireProject(repo, projectId);
  if (!reminder) {
    await repo.transactions.commit(new Map(), [reminderPath(projectId)]);
    return;
  }
  await repo.transactions.commit(
    new Map([[reminderPath(projectId), repo.json(ProjectReminderSchema.parse(reminder))]]),
  );
}

export async function listReminders(
  repo: PortableRepository,
): Promise<Array<ProjectReminder & { projectName?: string }>> {
  const out: Array<ProjectReminder & { projectName?: string }> = [];
  for (const project of await listProjects(repo)) {
    const reminder = await getProjectReminder(repo, project.id);
    if (reminder) out.push({ ...reminder, projectName: project.name });
  }
  return out;
}
