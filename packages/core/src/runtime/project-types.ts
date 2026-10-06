import { pickRandomNameWithGender } from '../names.js';
import { projectTypeIcon } from '../project-icons.js';
import {
  type ProjectTypeHost,
  projectTypeCrewMatch,
  projectTypeHostGap,
  projectTypeScriptHeader,
  projectTypeTemplateFrontmatter,
  renderProjectTypeTemplate,
  seedParamDefaults,
} from '../project-types/composition.js';
import {
  type AppliedProjectType,
  type CreateTypedProjectRequest,
  CreateTypedProjectRequestSchema,
} from '../schemas/api.js';
import type {
  CatalogItemDetail,
  CatalogItemSummary,
  ProjectTypeManifest,
} from '../schemas/catalog.js';
import type { Craftbook } from '../schemas/craftbook.js';
import type { GezelSummary } from '../schemas/gezel.js';
import { type Project, type ProjectDetail, ProjectSchema } from '../schemas/project.js';
import { ScriptNameSchema } from '../schemas/script.js';
import { pickRoleBasedName, slugifyEntityName } from './entities.js';
import { boundedText, encodeText, validatePortablePath } from './files.js';
import { type PortableCreateGezelInput, gezelRoot, gezelWrites, listGezels } from './gezels.js';
import { HttpStatusError } from './http/errors.js';
import { getProject, projectRoot, projectWrites } from './projects.js';
import type { PortableRepository } from './repository.js';

/**
 * One catalog project type as a host without the catalog service carries it:
 * the resolved item plus the version files applying and serving it reads.
 * Compiled by the host build from the pinned catalog.
 */
export interface PortableProjectType {
  /** The resolved catalog item; its manifest is a `project-type`. */
  item: CatalogItemDetail;
  /**
   * Version-relative text files: the about/mission templates, seeds, the
   * page tree under `pages/`, and embedded `craftbooks/`.
   */
  files: Record<string, string>;
  /** Version-relative binary page assets, base64. */
  binaryFiles?: Record<string, string>;
  /** The type's craftbooks this host can run, compiled by the build, by declared id. */
  craftbooks?: Record<string, Craftbook>;
}

type ProjectTypeEntry = PortableProjectType & {
  item: CatalogItemDetail & { manifest: ProjectTypeManifest };
};

function isProjectTypeEntry(entry: PortableProjectType): entry is ProjectTypeEntry {
  return entry.item.manifest.kind === 'project-type';
}

/**
 * The project types bundled with a host, loaded on first use so they cost
 * nothing at startup. A failed load is retried on the next request.
 */
export class PortableProjectTypes {
  private loading: Promise<readonly ProjectTypeEntry[]> | undefined;
  constructor(private readonly load: () => Promise<readonly PortableProjectType[]>) {}

  private all(): Promise<readonly ProjectTypeEntry[]> {
    this.loading ??= this.load().then(
      (entries) => entries.filter(isProjectTypeEntry),
      (error: unknown) => {
        this.loading = undefined;
        throw error;
      },
    );
    return this.loading;
  }

  /** Every bundled type, marked with why this host cannot run it when it cannot. */
  async summaries(host: ProjectTypeHost): Promise<CatalogItemSummary[]> {
    return (await this.all()).map(({ item }) => {
      const { readme: _readme, about: _about, ...summary } = item;
      const gap = projectTypeHostGap(item.manifest, host);
      return { ...summary, ...(gap ? { unavailableReason: gap } : {}) };
    });
  }

  /**
   * The bundled type for an id. A host carries one version of each type, so
   * a request pinned to another version gets the bundled one only when
   * `tolerateVersion` is set — an existing project keeps working after its
   * type moves on, as on the desktop; a new one never silently changes version.
   */
  async find(
    id: string,
    version?: string,
    tolerateVersion = false,
  ): Promise<ProjectTypeEntry | undefined> {
    const entry = (await this.all()).find(({ item }) => item.manifest.id === id);
    if (!entry) return undefined;
    if (version && entry.item.manifest.version !== version && !tolerateVersion) return undefined;
    return entry;
  }

  /** The applied type of a project, tolerating version drift. */
  async forProject(
    project: Pick<Project, 'projectType'> | null | undefined,
  ): Promise<ProjectTypeEntry | undefined> {
    const provenance = project?.projectType;
    if (!provenance) return undefined;
    return this.find(provenance.id, provenance.version, true);
  }
}

/** A version file of a type's page tree, confined to `pages/`. */
export function projectTypePageFile(
  entry: PortableProjectType,
  path: string,
): { text: string } | { bytes: Uint8Array } | null {
  const relative = validatePortablePath(path);
  const key = `pages/${relative}`;
  const text = entry.files[key];
  if (text !== undefined) return { text };
  const base64 = entry.binaryFiles?.[key];
  if (base64 === undefined) return null;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { bytes };
}

interface TypedProjectGezel {
  slot: number;
  input: PortableCreateGezelInput;
}

interface TypedProjectFile {
  area: 'workspace' | 'artifacts';
  path: string;
  content: string;
}

/** Everything a typed create writes, before identifiers are allocated. */
export interface PortableTypedProjectPlan {
  name: string;
  description?: string;
  icon?: Project['icon'];
  /** Project fields the type sets (mode, lead label, provenance, …). */
  fields: Partial<Project>;
  about: string;
  mission: string;
  /** Crew slots in manifest order: an existing gezel's id, or one to hire. */
  crew: Array<{ slot: number; templateId: string; voorman: boolean; existing?: GezelSummary }>;
  hires: TypedProjectGezel[];
  files: TypedProjectFile[];
  scripts: Array<{ name: string; source: string }>;
}

/**
 * Plan a typed project from a bundled type: the same rendering, crew reuse and
 * seeding the desktop's `applyProjectType` performs, without writing.
 */
export async function planPortableTypedProject(args: {
  request: CreateTypedProjectRequest;
  entry: ProjectTypeEntry;
  templates: readonly CatalogItemDetail[];
  installGezels: readonly GezelSummary[];
  /** Whether this host can run a declared craftbook (bundled or embedded). */
  craftbookAvailable: (id: string) => boolean;
  now: string;
}): Promise<{ plan: PortableTypedProjectPlan; applied: AppliedProjectType }> {
  const { request, entry } = args;
  const manifest = entry.item.manifest;
  const typeId = manifest.id;
  const params = { ...seedParamDefaults(manifest.params), ...(request.projectType.params ?? {}) };
  const render = (relative: string | undefined): string | undefined => {
    if (!relative) return undefined;
    const text = entry.files[relative];
    return text === undefined ? undefined : renderProjectTypeTemplate(text, params);
  };
  const about = render(manifest.aboutTemplate);
  const mission = render(manifest.missionTemplate);

  const reuse = manifest.leanProfile || request.projectType.reuseRosterGezels !== false;
  const pool = reuse ? args.installGezels : [];
  const taken = new Set<string>();
  const crew: PortableTypedProjectPlan['crew'] = [];
  const hires: TypedProjectGezel[] = [];
  for (const [slot, ref] of manifest.gezels.entries()) {
    const template = args.templates.find(
      (item) => item.manifest.kind === 'gezel-template' && item.manifest.id === ref.templateId,
    );
    const role = template?.manifest.kind === 'gezel-template' ? template.manifest.role : undefined;
    const existing = projectTypeCrewMatch(pool, { templateId: ref.templateId, role }, taken);
    if (existing) {
      taken.add(existing.id);
      crew.push({ slot, templateId: ref.templateId, voorman: ref.voorman, existing });
      continue;
    }
    if (!template || template.manifest.kind !== 'gezel-template') continue;
    const { name, gender } = pickRandomNameWithGender();
    const frontmatter = projectTypeTemplateFrontmatter(template.manifest.frontmatter);
    hires.push({
      slot,
      input: {
        name,
        role: template.manifest.role,
        about: template.about ?? '',
        gender,
        templateId: ref.templateId,
        templateVersion: template.manifest.version,
        ...(frontmatter ? { frontmatter } : {}),
      },
    });
    crew.push({ slot, templateId: ref.templateId, voorman: ref.voorman });
  }

  const scripts = Object.entries(manifest.scripts ?? {}).map(([name, body]) => ({
    name: ScriptNameSchema.parse(name),
    source: `${projectTypeScriptHeader(typeId, manifest.version)}${body}`,
  }));

  const files: TypedProjectFile[] = [];
  const seedText = (relative: string): string => {
    const text = entry.files[relative];
    if (text === undefined)
      throw new HttpStatusError(`Project type ${typeId}: seed file ${relative} is missing`, 500);
    return renderProjectTypeTemplate(text, params);
  };
  for (const relative of manifest.workspaceSeed)
    files.push({
      area: 'workspace',
      path: validatePortablePath(relative),
      content: seedText(relative),
    });
  for (const relative of manifest.artifactsSeed)
    files.push({
      area: 'artifacts',
      path: validatePortablePath(relative),
      content: seedText(relative),
    });

  const fields: Partial<Project> = {
    projectType: {
      id: typeId,
      version: manifest.version,
      source: entry.item.sourceId,
      icon: projectTypeIcon(manifest),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      appliedAt: args.now,
    },
    ...(manifest.extends ? { projectTypeId: manifest.extends } : {}),
    ...(manifest.mode ? { mode: manifest.mode } : request.mode ? { mode: request.mode } : {}),
    ...(manifest.leadLabel ? { leadLabel: manifest.leadLabel } : {}),
    ...(manifest.leanProfile !== undefined ? { leanProfile: manifest.leanProfile } : {}),
    ...(manifest.indexingEnabled !== undefined
      ? { indexingEnabled: manifest.indexingEnabled }
      : {}),
    ...(manifest.meesterManaged !== undefined
      ? { nudgeConfig: { enabled: manifest.meesterManaged } }
      : {}),
    ...(manifest.tabVisibility !== undefined ? { tabVisibility: manifest.tabVisibility } : {}),
  };

  const missingCraftbooks = manifest.craftbooks.filter(
    (id) => !entry.craftbooks?.[id] && !args.craftbookAvailable(id),
  );
  const applied: AppliedProjectType = {
    typeId,
    version: manifest.version,
    source: entry.item.sourceId,
    // Filled in once identifiers exist.
    gezelsCreated: [],
    scriptsInstalled: scripts.map((script) => script.name),
    workspaceSeeded: [
      ...manifest.workspaceSeed,
      ...manifest.artifactsSeed.map((relative) => `artifacts/${relative}`),
    ],
    seedsSkipped: [],
    toolsetsInstalled: [],
    toolsBound: manifest.tools.map((tool) => tool.name),
    // This host resolves a type's craftbooks from the bundle; nothing is copied.
    craftbooksInstalled: [],
    // Recurring runs need a host that runs while the app is closed.
    schedulesCreated: [],
    aboutRendered: about !== undefined,
    missionRendered: mission !== undefined,
    deferred: {
      toolsets: manifest.toolsets.map((toolset) => toolset.id),
      craftbooks: missingCraftbooks,
      pages: manifest.pages !== undefined,
      schedules: manifest.schedules.length,
    },
  };
  return {
    plan: {
      name: request.name.trim(),
      ...(request.description ? { description: request.description } : {}),
      ...(request.icon ? { icon: request.icon } : {}),
      fields,
      about: about ?? '',
      mission: mission ?? '',
      crew,
      hires,
      files,
      scripts,
    },
    applied,
  };
}

/**
 * Write a planned typed project in one transaction: the project, its new
 * gezels, scripts and seeds become visible together or not at all.
 */
export async function commitPortableTypedProject(
  repo: PortableRepository,
  plan: PortableTypedProjectPlan,
  applied: AppliedProjectType,
): Promise<{ project: ProjectDetail; applied: AppliedProjectType; hired: string[] }> {
  if (!plan.name) throw new HttpStatusError('A project name is required');
  const id = await repo.uniqueId('projects', slugifyEntityName(plan.name) || repo.createId());
  const root = projectRoot(id);
  const writes = new Map<string, Uint8Array>();
  const folders = [`${root}/workspace`, `${root}/artifacts`];

  const reserved = new Set<string>();
  const roleNames = new Set(
    (await listGezels(repo)).flatMap((gezel) => (gezel.roleBasedName ? [gezel.roleBasedName] : [])),
  );
  const hiredIds = new Map<number, { id: string; name: string }>();
  for (const hire of plan.hires) {
    let gezelId = await repo.uniqueId(
      'gezels',
      slugifyEntityName(hire.input.name) || repo.createId(),
    );
    for (let suffix = 2; reserved.has(gezelId); suffix++)
      gezelId = await repo.uniqueId('gezels', `${slugifyEntityName(hire.input.name)}-${suffix}`);
    reserved.add(gezelId);
    const roleBasedName = pickRoleBasedName(hire.input.role, roleNames);
    if (roleBasedName) roleNames.add(roleBasedName);
    for (const [path, bytes] of gezelWrites(repo, {
      ...hire.input,
      id: gezelId,
      ...(roleBasedName ? { roleBasedName } : {}),
    }))
      writes.set(path, bytes);
    folders.push(`${gezelRoot(gezelId)}/sessions`);
    hiredIds.set(hire.slot, { id: gezelId, name: hire.input.name });
  }

  const gezelsCreated: AppliedProjectType['gezelsCreated'] = [];
  let voormanGezelId: string | undefined;
  for (const member of plan.crew) {
    const hired = hiredIds.get(member.slot);
    const gezel = member.existing ? { id: member.existing.id, name: member.existing.name } : hired;
    if (!gezel) continue;
    gezelsCreated.push({
      id: gezel.id,
      name: gezel.name,
      templateId: member.templateId,
      voorman: member.voorman,
      ...(member.existing ? { reused: true } : {}),
    });
    if (member.voorman && !voormanGezelId) voormanGezelId = gezel.id;
  }

  const at = repo.now();
  const project = ProjectSchema.parse({
    ...plan.fields,
    id,
    name: plan.name,
    ...(plan.description ? { description: plan.description } : {}),
    ...(plan.icon ? { icon: plan.icon } : {}),
    gezelIds: [...new Set(gezelsCreated.map((gezel) => gezel.id))],
    ...(voormanGezelId ? { voormanGezelId } : {}),
    createdAt: at,
    updatedAt: at,
  });
  for (const [path, bytes] of projectWrites(repo, project, plan.about, plan.mission))
    writes.set(path, bytes);
  for (const file of plan.files)
    writes.set(
      `${root}/${file.area}/${validatePortablePath(file.path)}`,
      boundedText(file.content),
    );
  for (const script of plan.scripts)
    writes.set(`${root}/scripts/${script.name}.ts`, encodeText(script.source));

  await repo.transactions.commit(writes, [], folders);
  return {
    project: (await getProject(repo, id))!,
    applied: { ...applied, gezelsCreated },
    hired: [...hiredIds.values()].map((gezel) => gezel.id),
  };
}

/** Parse a typed-create body, refusing fields a typed create never takes. */
export function parseTypedProjectRequest(body: unknown): CreateTypedProjectRequest {
  return CreateTypedProjectRequestSchema.parse(body);
}
