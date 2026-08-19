import type { ProjectFileEntry } from '@bendyline/gezel';

export type LinkedWorkspaceTarget =
  | { kind: 'current'; projectId: string; path: string; displayPath: string }
  | {
      kind: 'linked';
      projectId: string;
      path: string;
      displayPath: string;
      linkedFromProjectId: string;
    }
  | { kind: 'links-root'; projectId: string; path: '..'; displayPath: '..' };

export function isLinkedWorkspacePath(inputPath: string): boolean {
  const normalized = inputPath.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  return normalized === '..' || normalized === '../' || normalized.startsWith('../');
}

/**
 * Parse the model-facing virtual sibling syntax without ever passing `..` to
 * a filesystem resolver. Only direct, explicitly supplied ids are admitted.
 */
export function resolveLinkedWorkspacePath(
  sourceProjectId: string,
  linkedProjectIds: readonly string[],
  inputPath: string,
): LinkedWorkspaceTarget {
  const normalized = inputPath.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  if (normalized === '..' || normalized === '../') {
    return { kind: 'links-root', projectId: sourceProjectId, path: '..', displayPath: '..' };
  }
  if (!normalized.startsWith('../')) {
    return {
      kind: 'current',
      projectId: sourceProjectId,
      path: normalized,
      displayPath: normalized,
    };
  }

  const remainder = normalized.slice(3);
  const slash = remainder.indexOf('/');
  const targetProjectId = slash === -1 ? remainder : remainder.slice(0, slash);
  const targetPath = slash === -1 ? '' : remainder.slice(slash + 1);
  if (!targetProjectId || !linkedProjectIds.includes(targetProjectId)) {
    const available = linkedProjectIds.length > 0 ? linkedProjectIds.join(', ') : 'none';
    throw new Error(
      `project "${targetProjectId || '(missing)'}" is not linked from ${sourceProjectId}; linked projects: ${available}`,
    );
  }
  return {
    kind: 'linked',
    projectId: targetProjectId,
    path: targetPath,
    displayPath: linkedDisplayPath(targetProjectId, targetPath),
    linkedFromProjectId: sourceProjectId,
  };
}

export function linkedDisplayPath(projectId: string, path: string): string {
  return path ? `../${projectId}/${path}` : `../${projectId}`;
}

export function linkedProjectEntries(projectIds: readonly string[]): ProjectFileEntry[] {
  return projectIds.map((id) => ({ name: id, path: `../${id}`, isDirectory: true }));
}

export function prefixLinkedEntry(projectId: string, entry: ProjectFileEntry): ProjectFileEntry {
  return {
    ...entry,
    path: linkedDisplayPath(projectId, entry.path),
  };
}
