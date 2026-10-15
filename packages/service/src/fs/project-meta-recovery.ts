import { type HistoryEvent, type Project, ProjectSchema } from '@bendyline/gezel';

/**
 * Recovery for a `project.json` that does not parse.
 *
 * Before `writeFileAtomic`, a crash between a plain write's size extension and
 * its data flush left NTFS/ext4 with a file of the right length and all-NUL
 * contents (see `Store.writeSession`). The project then vanished from every
 * listing while its tasks, sessions and documents sat intact beside it, and
 * every poll re-logged the parse failure.
 *
 * NUL bytes and an empty file are an interrupted write's fingerprint, never an
 * edit's, so that file is ours to repair. Plain text that does not parse may be
 * a person's half-finished edit and is left alone.
 */
export type ProjectJsonDamage =
  /** Parses as-is: another reader repaired it first. */
  | { kind: 'valid'; value: unknown }
  /** Parses once a byte-order mark and stray NULs are removed. */
  | { kind: 'salvaged'; value: unknown }
  /** NULs or no content, and nothing parseable left. */
  | { kind: 'crash-damaged' }
  /** Text that does not parse, with no sign of an interrupted write. */
  | { kind: 'malformed' };

export function inspectProjectJson(raw: string): ProjectJsonDamage {
  try {
    return { kind: 'valid', value: JSON.parse(raw) };
  } catch {
    // Classified below.
  }
  const crashDamaged = raw.includes('\u0000') || raw.trim() === '';
  const cleaned = raw.replaceAll('\u0000', '').replace(/^﻿/, '').trim();
  if (cleaned !== raw && cleaned !== '') {
    try {
      return { kind: 'salvaged', value: JSON.parse(cleaned) };
    } catch {
      // Nothing to salvage.
    }
  }
  return crashDamaged ? { kind: 'crash-damaged' } : { kind: 'malformed' };
}

/** Events in a project's `history.jsonl`, skipping lines a crash garbled. */
export function parseProjectHistory(raw: string): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  for (const line of raw.split('\n')) {
    // The same crash leaves a run of NULs in front of the next appended line.
    const text = line.replaceAll('\u0000', '').trim();
    if (!text) continue;
    try {
      const event = JSON.parse(text) as HistoryEvent;
      if (typeof event?.kind === 'string' && typeof event.at === 'string') events.push(event);
    } catch {
      // A torn line.
    }
  }
  return events;
}

/**
 * Rebuild a project record from its history.
 *
 * Only identity and presentation come back. Grants (workspace writes,
 * credentials, provider permission modes) are logged inside `project.updated`
 * patches but deliberately not replayed: a rebuilt project starts from the safe
 * defaults and the person grants again what they meant to.
 */
export function rebuildProjectFromHistory(
  id: string,
  events: readonly HistoryEvent[],
  fallbackAt: string,
): Project {
  const ordered = events
    .filter((event) => event.projectId === id)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let project: Project = {
    id,
    name: nameFromId(id),
    createdAt: ordered[0]?.at ?? fallbackAt,
    updatedAt: ordered.at(-1)?.at ?? fallbackAt,
  };
  const roster = new Set<string>();
  for (const event of ordered) {
    const details = asRecord(event.details);
    switch (event.kind) {
      case 'project.created':
        project = { ...project, ...identityFields(details), createdAt: event.at };
        // Mirrors createProject: an opened folder starts with check-ins off.
        if (project.workingDir) project.nudgeConfig = { enabled: false };
        if (typeof details.githubUrl === 'string') project.github = { url: details.githubUrl };
        break;
      case 'project.updated':
        project = { ...project, ...identityFields(asRecord(details.patch)) };
        break;
      case 'project.voorman.changed':
        project.voormanGezelId = nonEmptyString(details.voormanGezelId);
        break;
      case 'project.gezel.joined':
        if (event.gezelId) roster.add(event.gezelId);
        break;
      case 'project.gezel.left':
        if (event.gezelId) roster.delete(event.gezelId);
        break;
      case 'project.status.changed':
        project.status =
          details.status === 'readonly' ||
          details.status === 'inactive' ||
          details.status === 'stable'
            ? details.status
            : undefined;
        break;
    }
  }
  if (roster.size > 0) project.gezelIds = [...roster];
  const result = ProjectSchema.safeParse(project);
  if (result.success) return result.data;
  return { id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt };
}

function identityFields(source: Record<string, unknown>): Partial<Project> {
  const out: Partial<Project> = {};
  const name = nonEmptyString(source.name);
  if (name) out.name = name;
  if (typeof source.description === 'string') out.description = source.description;
  else if (source.description === null) out.description = undefined;
  if (typeof source.icon === 'string') out.icon = source.icon as Project['icon'];
  else if (source.icon === null) out.icon = undefined;
  if ('workingDir' in source && source.workingDir !== undefined) {
    out.workingDir = nonEmptyString(source.workingDir);
  }
  if (typeof source.indexingEnabled === 'boolean') out.indexingEnabled = source.indexingEnabled;
  if (typeof source.nightlyFixesEnabled === 'boolean') {
    out.nightlyFixesEnabled = source.nightlyFixesEnabled;
  }
  if (typeof source.archived === 'boolean') out.archived = source.archived || undefined;
  return out;
}

/** `vampire-hunter-game` → `Vampire Hunter Game`, for a project with no history. */
function nameFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
