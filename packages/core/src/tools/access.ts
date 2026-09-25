import { toolsetGroupsForRole } from '../roles/index.js';
import { BUILTIN_TOOLSETS } from './builtin-groups.js';

const groups = new Map(BUILTIN_TOOLSETS.map((group) => [group.id, group.tools]));
/** Shared group expansion: unknown grants never add authority. */
export function expandToolsetGroups(ids: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const id of ids)
    for (const group of id === 'workspace-fs' ? ['workspace-fs-read', 'workspace-fs-write'] : [id])
      for (const name of groups.get(group) ?? []) names.add(name);
  return names;
}
export function roleHasTeamScope(role: string | undefined, projectMode?: 'crew' | 'solo'): boolean {
  return projectMode !== 'solo' && toolsetGroupsForRole(role).includes('team-management');
}
export function roleToolNames(
  role: string | undefined,
  projectMode?: 'crew' | 'solo',
): Set<string> {
  return expandToolsetGroups(
    toolsetGroupsForRole(role).filter(
      (group) => projectMode !== 'solo' || group !== 'team-management',
    ),
  );
}
