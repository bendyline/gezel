import { folderKindOf } from './folder-kind.js';
import { isCodingProject } from './project-types/taxonomy.js';

/** Project types whose provenance predates the stamped category but are codebases. */
const LEGACY_CODE_PROJECT_TYPES: ReadonlySet<string> = new Set(['software-project']);

/**
 * Whether a project is a codebase: the one answer for every surface and
 * service that treats code differently (night fixes, the Node workspace
 * template, developer tabs).
 *
 * In order: the kind recorded when an added folder's crew was recruited; a
 * project type in the `code` category; a detected or chosen coding type; a
 * linked GitHub repository. A Software Project made from the catalog counts
 * from the moment it exists, before any file has been detected.
 *
 * A category only ever adds a project. Data Analysis sits in `data` but
 * extends the coding `data-analysis` id, and must stay a codebase.
 */
export function projectHoldsCode(project: {
  properties?: Record<string, string>;
  projectType?: { id: string; category?: string | undefined } | undefined;
  projectTypeId?: string;
  detectedProjectType?: { id: string };
  github?: { url?: string | undefined } | undefined;
}): boolean {
  const kind = folderKindOf(project);
  if (kind) return kind === 'code';
  const applied = project.projectType;
  if (applied?.category === 'code') return true;
  if (applied && LEGACY_CODE_PROJECT_TYPES.has(applied.id)) return true;
  return isCodingProject(project) || Boolean(project.github?.url);
}
