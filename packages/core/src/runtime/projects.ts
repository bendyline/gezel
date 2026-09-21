import { assertSafeEntityId, isSafeEntityId } from '../entity-id.js';
import {
  type CreateProjectRequest,
  CreateProjectRequestSchema,
  type GezelConfig,
  GezelConfigSchema,
  type UpdateProjectRequest,
  UpdateProjectRequestSchema,
} from '../schemas/api.js';
import { type Project, type ProjectDetail, ProjectSchema } from '../schemas/project.js';
import { SHARED_PROJECT_MARKER, isSharedLibraryProject } from '../shared-project.js';
import { slugifyEntityName } from './entities.js';
import { boundedText } from './files.js';
import type { PortableRepository } from './repository.js';

export const projectRoot = (id: string): string => {
  assertSafeEntityId(id, 'project id');
  return `projects/${id}`;
};
export async function readConfig(repo: PortableRepository): Promise<GezelConfig> {
  return (await repo.record('config.json', GezelConfigSchema)) ?? {};
}
export async function writeConfig(
  repo: PortableRepository,
  patch: Partial<{ [K in keyof GezelConfig]: GezelConfig[K] | null }>,
): Promise<GezelConfig> {
  const before = await readConfig(repo);
  if (patch.sharedProjectId !== undefined && patch.sharedProjectId !== before.sharedProjectId)
    throw new Error('The shared library identity is managed by Gezel');
  const merged: Record<string, unknown> = { ...before, ...patch };
  for (const [key, value] of Object.entries(patch)) if (value === null) delete merged[key];
  const config = GezelConfigSchema.parse(merged);
  if (
    config.meesterGezelId &&
    !(await repo.exists(`gezels/${safeId(config.meesterGezelId)}/gezel.md`))
  )
    throw new Error('The selected Meester does not exist');
  await repo.transactions.commit(new Map([['config.json', repo.json(config)]]));
  return config;
}
function safeId(id: string): string {
  assertSafeEntityId(id);
  return id;
}
export async function getProject(
  repo: PortableRepository,
  id: string,
): Promise<ProjectDetail | null> {
  const root = projectRoot(id);
  const project = await repo.record(`${root}/project.json`, ProjectSchema);
  if (!project) return null;
  if (project.id !== id) throw new Error('Project identity does not match its directory');
  const about = await repo.text(`${root}/documents/about.md`);
  const missionObjectives = await repo.text(`${root}/documents/missionObjectives.md`);
  return {
    ...project,
    packages: [],
    ...(about === null ? {} : { about }),
    ...(missionObjectives === null ? {} : { missionObjectives }),
  };
}
export async function requireProject(repo: PortableRepository, id: string): Promise<ProjectDetail> {
  const project = await getProject(repo, id);
  if (!project) throw new Error(`Project ${id} could not be found`);
  return project;
}
export async function listProjects(repo: PortableRepository): Promise<Project[]> {
  const projects: Project[] = [];
  for (const entry of await repo.list('projects')) {
    if (!entry.isDirectory || !isSafeEntityId(entry.name)) continue;
    const project = await getProject(repo, entry.name);
    if (project) projects.push(ProjectSchema.parse(project));
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
export function projectWrites(
  repo: PortableRepository,
  project: Project,
  about = '',
  mission = '',
): Map<string, Uint8Array> {
  const root = projectRoot(project.id);
  return new Map([
    [`${root}/project.json`, repo.json(ProjectSchema.parse(project))],
    [`${root}/documents/about.md`, boundedText(about)],
    [`${root}/documents/missionObjectives.md`, boundedText(mission)],
  ]);
}
export async function createProject(
  repo: PortableRepository,
  raw: CreateProjectRequest,
  options?: { id?: string },
): Promise<ProjectDetail> {
  const input = CreateProjectRequestSchema.parse(raw);
  if (input.workingDir || input.github)
    throw new Error('External folders and Git checkouts are not supported by this runtime');
  const id =
    options?.id ??
    (await repo.uniqueId('projects', slugifyEntityName(input.name) || repo.createId()));
  const root = projectRoot(id);
  if (await repo.exists(root)) throw new Error('A project already owns this identifier');
  const at = repo.now();
  const project = ProjectSchema.parse({
    ...input,
    id,
    name: input.name.trim(),
    createdAt: at,
    updatedAt: at,
  });
  if (!project.name) throw new Error('A project name is required');
  await repo.transactions.commit(
    projectWrites(repo, project, input.about, input.missionObjectives),
    [],
    [`${root}/workspace`, `${root}/artifacts`],
  );
  return (await getProject(repo, id))!;
}
export async function updateProject(
  repo: PortableRepository,
  id: string,
  raw: UpdateProjectRequest,
): Promise<ProjectDetail> {
  const patch = UpdateProjectRequestSchema.parse(raw);
  const before = await requireProject(repo, id);
  if (patch.name !== undefined) {
    patch.name = patch.name.trim();
    if (!patch.name) throw new Error('A project name is required');
  }
  if (
    patch.properties?.[SHARED_PROJECT_MARKER] !== undefined &&
    patch.properties[SHARED_PROJECT_MARKER] !== before.properties?.[SHARED_PROJECT_MARKER]
  )
    throw new Error('The shared library identity is managed by Gezel');
  if (
    patch.linkedProjectIds &&
    new Set(patch.linkedProjectIds).size !== patch.linkedProjectIds.length
  )
    throw new Error('Linked projects must be unique');
  if (patch.workingDir !== undefined || patch.github !== undefined)
    throw new Error('External folders and Git checkouts are not supported by this runtime');
  if (
    isSharedLibraryProject(before) &&
    (patch.voormanGezelId ||
      patch.archived ||
      patch.properties?.[SHARED_PROJECT_MARKER] !== undefined)
  )
    throw new Error('The shared library cannot become a jobsite or be archived');
  if (
    patch.voormanGezelId &&
    !(await repo.exists(`gezels/${safeId(patch.voormanGezelId)}/gezel.md`))
  )
    throw new Error('The project lead does not exist');
  if (patch.linkedProjectIds)
    for (const linked of patch.linkedProjectIds) {
      if (linked === id || isSharedLibraryProject(await requireProject(repo, linked)))
        throw new Error('Invalid linked project');
    }
  const next: Record<string, unknown> = { ...before, ...patch, updatedAt: repo.now() };
  for (const [key, value] of Object.entries(patch)) if (value === null) delete next[key];
  if (patch.properties) next.properties = { ...before.properties, ...patch.properties };
  if (patch.voormanGezelId)
    next.gezelIds = [...new Set([...(before.gezelIds ?? []), patch.voormanGezelId])];
  if (next.archived) next.status = 'inactive';
  const project = ProjectSchema.parse(next);
  const writes = new Map([[`${projectRoot(id)}/project.json`, repo.json(project)]]);
  if (patch.about !== undefined)
    writes.set(`${projectRoot(id)}/documents/about.md`, boundedText(patch.about));
  if (patch.missionObjectives !== undefined)
    writes.set(
      `${projectRoot(id)}/documents/missionObjectives.md`,
      boundedText(patch.missionObjectives),
    );
  await repo.transactions.commit(writes);
  return (await getProject(repo, id))!;
}
export async function setRoster(
  repo: PortableRepository,
  id: string,
  gezelId: string,
  add: boolean,
): Promise<ProjectDetail> {
  const project = await requireProject(repo, id);
  if (!(await repo.exists(`gezels/${safeId(gezelId)}/gezel.md`)))
    throw new Error('This gezel does not exist');
  const roster = new Set(project.gezelIds ?? []);
  if (add) roster.add(gezelId);
  else roster.delete(gezelId);
  const updated = { ...project, gezelIds: [...roster], updatedAt: repo.now() };
  if (!add && project.voormanGezelId === gezelId) delete updated.voormanGezelId;
  await repo.transactions.commit(
    new Map([[`${projectRoot(id)}/project.json`, repo.json(ProjectSchema.parse(updated))]]),
  );
  return (await getProject(repo, id))!;
}
export async function sharedProjectId(repo: PortableRepository): Promise<string | null> {
  const id = (await readConfig(repo)).sharedProjectId ?? 'shared';
  const project = await getProject(repo, id);
  return project && isSharedLibraryProject(project) ? id : null;
}
