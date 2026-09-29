import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { Project } from '@bendyline/gezel';
import { type GezelClient, ensureProjectForFolder } from '@bendyline/gezel-client/node';
import type * as vscode from 'vscode';
import type { Logger } from './log.js';

/**
 * Lookup-or-create a project for a workspace folder. Idempotent. Delegates to
 * the shared `ensureProjectForFolder` (the daemon's folder inference): reuse
 * the project bound to this folder, adopt a same-name project with no
 * folder, else create one. The daemon refuses folders gezel must not own
 * (the home folder, a drive root) with 403 `forbidden_root`.
 */
export async function ensureProjectForWorkspace(
  folder: vscode.WorkspaceFolder,
  client: GezelClient,
  logger: Logger,
): Promise<string> {
  const wd = canonicalizePath(folder.uri.fsPath);
  const name = basename(wd) || 'workspace';
  const result = await ensureProjectForFolder(client, wd, {
    mode: 'crew',
    source: 'vscode',
    description: `VSCode workspace at ${wd}`,
    about: defaultAbout(name, wd),
    missionObjectives: defaultMission(name),
  });
  logger.info(`${result.created ? 'created' : 'using'} project ${result.projectId} for ${wd}`);
  return result.projectId;
}

/**
 * Resolve symlinks; on missing path (rare — folder may have been deleted
 * while VSCode caches it) fall back to the raw input.
 */
function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Case-insensitive equality on Windows; case-sensitive elsewhere. Both
 * sides are normalized to forward slashes so a daemon-side `\\` path
 * still matches an `fs.realpath` `/`-style path.
 */
export function pathsEqual(a: string, b: string): boolean {
  const na = a.replace(/\\/g, '/').replace(/\/+$/, '');
  const nb = b.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

function defaultAbout(name: string, wd: string): string {
  // Must be ≥ 60 chars (CreateProjectRequestSchema.about.min(60)).
  return `${name} is a workspace opened in VSCode at ${wd}. Gezels working here treat the folder as the project root for code edits, tasks, and artifacts. Update this description from the gezel desktop app when the project takes shape.`;
}

function defaultMission(name: string): string {
  // Must be ≥ 40 chars (CreateProjectRequestSchema.missionObjectives.min(40)).
  return `Help the human collaborator make progress on ${name}. Specific objectives will be filled in once the work is scoped.`;
}

export function findProjectByWorkingDir(
  projects: Project[],
  workingDir: string,
): Project | undefined {
  const wd = canonicalizePath(workingDir);
  return projects.find((p) => p.workingDir && pathsEqual(p.workingDir, wd));
}

export async function ensureDevGezel(
  client: GezelClient,
  preferredName: string,
  logger: Logger,
): Promise<{ id: string; name: string }> {
  const existing = await client.listGezels();
  const match = existing.gezels.find((g) => g.name.toLowerCase() === preferredName.toLowerCase());
  if (match) {
    logger.info(`using existing gezel "${match.name}" (${match.id})`);
    return { id: match.id, name: match.name };
  }
  const result = await client.ensureGezel({
    jobTitle: 'Software developer',
    preferredName,
  });
  logger.info(`ensured gezel "${result.name}" (${result.gezelId}) — ${result.action}`);
  return { id: result.gezelId, name: result.name };
}
