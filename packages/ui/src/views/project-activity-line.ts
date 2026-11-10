import type { HistoryEntry } from '@bendyline/gezel';
import { getProjectType } from '@bendyline/gezel';

/**
 * The Overview's recent-activity lines, as a person reads them. History
 * summaries are written for the log, the History view and the crew's
 * `search_history`: they carry task refs (`office/1`), catalog versions
 * (`freelance-office@1.1.0`) and full folder paths. Those stay in the log;
 * this only words them for the page.
 */

type HistoryEventEntry = Extract<HistoryEntry, { entryType: 'event' }>;

const PROJECT_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  stable: 'Stable',
  readonly: 'Read-only',
  inactive: 'Inactive',
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The last segment of a path, whichever separator it uses. */
export function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || path;
}

/** A catalog id as a name: `freelance-office` → `Freelance Office`. */
function typeName(id: string): string {
  const known = getProjectType(id)?.label;
  if (known) return known;
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function taskNumber(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Words the log leaves for engineers, taken out of a summary no rule below
 * covers: this project's task refs become "task N", catalog versions go, and
 * an absolute path keeps only its last name.
 */
export function plainActivitySummary(summary: string, projectId: string): string {
  return summary
    .replace(new RegExp(`\\b${escapeRegExp(projectId)}/(\\d+)\\b`, 'g'), 'task $1')
    .replace(/@\d+(?:\.\d+)+(?:[-+][\w.]+)?/g, '')
    .replace(/[A-Za-z]:\\[^\s"'()]+/g, (path) => pathBasename(path))
    .replace(/(^|[\s"'(])(\/[^\s"'()]+\/[^\s"'()]+)/g, (_, lead: string, path: string) => {
      return `${lead}${pathBasename(path)}`;
    });
}

function taskStatusSentence(
  status: string | undefined,
  previous: string | undefined,
  subject: string,
): string | null {
  switch (status) {
    case 'complete':
      return `Finished ${subject}`;
    case 'paused':
      return `Paused ${subject}`;
    case 'canceled':
      return `Canceled ${subject}`;
    case 'draft':
      return `Moved ${subject} back to draft`;
    case 'active':
      if (previous === 'paused') return `Resumed ${subject}`;
      if (previous === 'complete' || previous === 'canceled') return `Reopened ${subject}`;
      return `Started ${subject}`;
    default:
      return null;
  }
}

/** Task titles the listed entries know, by ref, so a status line can name its task. */
export function taskTitlesFrom(entries: readonly HistoryEntry[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const entry of entries) {
    if (entry.entryType !== 'event') continue;
    const ref = text(entry.details?.ref);
    const title = text(entry.details?.title);
    if (ref && title && !titles.has(ref)) titles.set(ref, title);
  }
  return titles;
}

function eventLine(
  entry: HistoryEventEntry,
  projectId: string,
  taskTitles: ReadonlyMap<string, string>,
): string {
  const details = entry.details ?? {};
  switch (entry.kind) {
    case 'project.created':
      return 'Project created';
    case 'project.inferred': {
      const root = text(details.root);
      const folder = root ? ` "${pathBasename(root)}"` : '';
      return details.created === false
        ? `Linked to the folder${folder}`
        : `Project created for the folder${folder}`;
    }
    case 'project.updated':
    case 'ai-app.applied': {
      const type = text(details.projectType) ?? text(details.appId);
      if (type) return `Set up as ${typeName(type)}`;
      break;
    }
    case 'project.status.changed': {
      const status = text(details.status);
      if (status) return `Status changed to ${PROJECT_STATUS_LABELS[status] ?? status}`;
      break;
    }
    case 'task.created': {
      const title = text(details.title);
      if (title) return `New task: ${title}`;
      break;
    }
    case 'task.status.changed':
    case 'task.canceled': {
      const ref = text(details.ref);
      if (!ref) break;
      const title = text(details.title) ?? taskTitles.get(ref);
      const subject = title ? `"${title}"` : `task ${taskNumber(ref)}`;
      const status = entry.kind === 'task.canceled' ? 'canceled' : text(details.status);
      const sentence = taskStatusSentence(status, text(details.previous), subject);
      if (sentence) return sentence;
      break;
    }
  }
  return plainActivitySummary(entry.summary, projectId);
}

/** One recent-activity line for a person: a plain sentence, no ids or versions. */
export function projectActivityLine(
  entry: HistoryEntry,
  projectId: string,
  taskTitles: ReadonlyMap<string, string> = new Map(),
): string {
  if (entry.entryType === 'session') return `Chat: ${entry.title}`;
  return eventLine(entry, projectId, taskTitles);
}
