import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { GezelSdkError } from './errors.js';
import type { EnsureModelResult, EnsureProjectOptions, EnsureProjectResult } from './host-types.js';

export interface EnsureProjectDeps {
  client: GezelClient;
  ensureModel(input: {
    model: string;
    bundle?: string;
    onEvent?: EnsureProjectOptions['onEvent'];
  }): Promise<EnsureModelResult>;
}

/**
 * Make sure this application has its project.
 *
 * With a `.gezapp`, the project also gets that app's crew, scripts and seeds,
 * and the app's model dependencies are installed. Without one, the folder is
 * simply bound to a project — which is all an application that ships no AI App
 * needs.
 *
 * Idempotent by construction, because it runs on every launch: importing the
 * same package is a no-op, applying the same type preserves the user's edits
 * (`seedPolicy: 'preserve'`) and reuses the crew already on the roster
 * (`reuseRosterGezels`), and the result reports the gezel ids either way.
 */
export async function ensureProject(
  deps: EnsureProjectDeps,
  opts: EnsureProjectOptions,
): Promise<EnsureProjectResult> {
  if (!opts.package) return await bareProject(deps.client, opts.folder);

  const bytes =
    typeof opts.package === 'string' ? new Uint8Array(await readFile(opts.package)) : opts.package;

  const imported = await deps.client.importAiAppPackage(bytes, { confirm: true });
  const appId = imported.manifest.entry.projectType;
  const version = imported.installed?.version ?? imported.manifest.entry.version;

  const modelsEnsured: string[] = [];
  if (opts.ensureModels !== false) {
    for (const dependency of imported.dependencies) {
      if (dependency.kind !== 'chat-model') continue;
      const bundle = opts.bundles?.[dependency.id];
      await deps.ensureModel({
        model: dependency.id,
        ...(bundle ? { bundle } : {}),
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      });
      modelsEnsured.push(dependency.id);
    }
  }

  const projectId = await ensureProjectForFolder(deps.client, opts.folder);
  await assertFolderIsFree(deps.client, projectId, appId, opts.force === true);

  const body = {
    typeId: appId,
    ...((opts.version ?? version) ? { version: opts.version ?? version } : {}),
    ...(opts.params ? { params: opts.params } : {}),
    // The user's own edits to seeded files and their existing crew survive a
    // relaunch; an app that overwrote either would be rewriting their work
    // every time it started.
    seedPolicy: 'preserve' as const,
    reuseRosterGezels: true,
  };
  const applied = await deps.client.applyProjectType(projectId, body);

  const gezels: Record<string, string> = {};
  for (const gezel of applied.gezelsCreated) gezels[gezel.templateId] = gezel.id;
  // `voorman` is the daemon's existing wire field for a project's lead.
  const lead = applied.gezelsCreated.find((gezel) => gezel.voorman);

  return {
    appId,
    version,
    projectId,
    gezels,
    ...(lead ? { leadGezelId: lead.id } : {}),
    imported: imported.installed?.alreadyPresent !== true,
    modelsEnsured,
  };
}

/**
 * A project with no AI App applied: the folder is bound, and whatever crew the
 * project already has is reported.
 */
async function bareProject(client: GezelClient, folder: string): Promise<EnsureProjectResult> {
  const projectId = await ensureProjectForFolder(client, folder);
  const project = await client.getProject(projectId);
  const gezels: Record<string, string> = {};
  const roster = await client.listGezels().catch(() => ({ gezels: [] }));
  for (const gezel of roster.gezels) {
    if (!project.gezelIds?.includes(gezel.id)) continue;
    if (gezel.templateId) gezels[gezel.templateId] = gezel.id;
  }
  return {
    projectId,
    gezels,
    ...(project.voormanGezelId ? { leadGezelId: project.voormanGezelId } : {}),
    modelsEnsured: [],
  };
}

/**
 * Find or create the project bound to a folder. Mirrors what the CLI does for
 * a working directory: an exact match wins, an unbound project of the same
 * name is adopted, otherwise a new one is created and bound.
 */
export async function ensureProjectForFolder(client: GezelClient, folder: string): Promise<string> {
  const workingDir = resolve(folder);
  const same = (candidate: string | undefined): boolean =>
    !!candidate &&
    (process.platform === 'win32'
      ? candidate.toLowerCase() === workingDir.toLowerCase()
      : candidate === workingDir);

  const { projects } = await client.listProjects();
  const exact = projects.find((project) => same(project.workingDir));
  if (exact) return exact.id;

  const name = basename(workingDir) || 'workspace';
  const orphan = projects.find((project) => !project.workingDir && project.name === name);
  if (orphan) {
    await client.setProjectWorkingDir(orphan.id, workingDir);
    return orphan.id;
  }

  const created = await client.createProject({
    name,
    description: `Workspace at ${workingDir}`,
    mode: 'solo',
    workingDir,
  });
  return created.id;
}

/**
 * Refuse to apply one app over another app's project.
 *
 * Two apps pointed at the same folder would each rewrite the other's crew and
 * seeds on every launch, and the user would see a project that never settles.
 */
async function assertFolderIsFree(
  client: GezelClient,
  projectId: string,
  appId: string,
  force: boolean,
): Promise<void> {
  if (force) return;
  const project = await client.getProject(projectId).catch(() => null);
  const existing = project?.projectType?.id;
  if (!existing || existing === appId) return;
  throw new GezelSdkError(
    `this folder already belongs to the "${existing}" app; pass force to let "${appId}" take it over`,
    { code: 'folder_has_other_app' },
  );
}
