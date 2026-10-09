import {
  CREW_RECRUITED_AT_PROPERTY,
  FOLDER_KIND_PROPERTY,
  type FolderKind,
  createLogger,
  inferFolderKind,
  inferredWellKnownKind,
  isCodingProject,
  isSharedLibraryProject,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ChatEventBus } from '../chat/events.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { ensureDefaultBoekwachter } from '../gezels/autonomous-roles.js';
import { ensureGezel, resolveGildeTemplateForRole } from '../gezels/ensure.js';
import type { HistoryManager } from '../history/manager.js';
import { scanFolderProfile } from '../project-type/scan-folder.js';
import {
  type ArmNightWorkResult,
  armResidentNightWork,
  setFolderNightWork,
} from '../suggested-work/arm.js';
import type { TaskManager } from '../tasks/manager.js';
import {
  type EnsureProjectLeadResult,
  ensureFolderProjectBuilder,
  ensureProjectVoorman,
} from '../workspace/import-sync.js';

const log = createLogger('projects');

/** The gilde template that leads a folder of photos. */
const CURATOR_TEMPLATE_ID = 'curator';

export interface RecruitCrewDeps {
  store: Store;
  chat: ChatManager;
  home: string;
  catalog: CatalogService;
}

export interface RecruitCrewResult {
  kind?: FolderKind;
  /** Gezels created for this folder, for the `gezel_created` event. */
  createdGezels: Array<{ id: string; name: string }>;
  skipped?: 'missing' | 'not-a-folder' | 'library' | 'already-recruited';
}

/**
 * Give a folder the person just added its crew: the Boekwachter, who reads,
 * describes and reviews it, plus a lead suited to what it holds. A codebase is
 * led by the Builder (who, with the Boekwachter, unlocks nightly proposed
 * fixes); a folder of photos by the Curator, where the catalog carries that
 * template; documents, mixed folders, and photos on an older catalog by the
 * Boekwachter, so a Documents folder never gets a developer drafting edits to
 * Word files.
 *
 * Only for a folder the person added themselves (onboarding, the add-folder
 * sheet), never from a scan, a document a client opened, or a model's tool
 * call: recruiting is what turns night work on, so it has to be the person's
 * act. Runs once per project (`CREW_RECRUITED_AT_PROPERTY`), so a gezel they
 * later remove is never re-added.
 */
export async function recruitCrewForFolder(
  deps: RecruitCrewDeps,
  projectId: string,
): Promise<RecruitCrewResult> {
  const { store, catalog } = deps;
  const createdGezels: RecruitCrewResult['createdGezels'] = [];
  const project = await store.getProject(projectId).catch(() => null);
  if (!project || projectId === 'default') return { createdGezels, skipped: 'missing' };
  if (isSharedLibraryProject(project)) return { createdGezels, skipped: 'library' };
  if (!project.workingDir) return { createdGezels, skipped: 'not-a-folder' };
  if (project.properties?.[CREW_RECRUITED_AT_PROPERTY]) {
    return { createdGezels, skipped: 'already-recruited' };
  }

  const coding = isCodingProject(project);
  const profile = coding ? null : await scanFolderProfile(project.workingDir);
  const kind = inferFolderKind({
    wellKnownKind: inferredWellKnownKind(project),
    coding,
    modalities: profile?.modalities,
  });

  const before = new Set((await store.listGezels().catch(() => [])).map((g) => g.id));
  const boekwachter = await ensureDefaultBoekwachter(store, catalog, {
    recruitProjectIds: [projectId],
  });
  if (!before.has(boekwachter.id)) {
    createdGezels.push({ id: boekwachter.id, name: boekwachter.name });
  }

  if (kind === 'code') {
    const ensureLead = project.mode === 'solo' ? ensureFolderProjectBuilder : ensureProjectVoorman;
    const lead = await ensureLead(deps, projectId).catch((err: unknown) => {
      log.warn(`[projects] ${projectId}: lead for a code folder failed: ${String(err)}`);
      return {} as EnsureProjectLeadResult;
    });
    if (lead.createdGezel) createdGezels.push(lead.createdGezel);
  } else if (!project.voormanGezelId || project.voormanAutoAssignedAt) {
    const curator = kind === 'pictures' ? await ensureCurator(deps, projectId) : null;
    if (curator?.created) createdGezels.push({ id: curator.id, name: curator.name });
    // Replace only a lead gezel seated on its own, never one the person chose.
    await store.updateProject(projectId, {
      voormanGezelId: curator?.id ?? boekwachter.id,
      voormanAutoAssignedAt: new Date().toISOString(),
    });
  }

  await store.updateProject(projectId, {
    properties: {
      [FOLDER_KIND_PROPERTY]: kind,
      [CREW_RECRUITED_AT_PROPERTY]: new Date().toISOString(),
    },
  });
  log.info(`[projects] ${projectId}: recruited crew for a ${kind} folder`);
  return { kind, createdGezels };
}

/**
 * The install's Curator on this folder's roster: the gezel made from the
 * curator template, else a new one from it. Null when the catalog predates the
 * template, so the caller falls back rather than recruiting whoever describes
 * themselves as a photographer.
 */
async function ensureCurator(
  deps: RecruitCrewDeps,
  projectId: string,
): Promise<{ id: string; name: string; created: boolean } | null> {
  const { store, catalog } = deps;
  const roster = await store.listGezels().catch(() => []);
  const onRoster = roster.some((g) => g.templateId === CURATOR_TEMPLATE_ID);
  if (!onRoster) {
    const template = await resolveGildeTemplateForRole(catalog, CURATOR_TEMPLATE_ID).catch(
      () => null,
    );
    if (template?.templateId !== CURATOR_TEMPLATE_ID) return null;
  }
  const curator = await ensureGezel({
    opts: { jobTitle: 'curator', templateId: CURATOR_TEMPLATE_ID },
    store,
    catalog,
    chat: deps.chat,
    bespokeMode: 'static',
  }).catch((err: unknown) => {
    log.warn(`[projects] ${projectId}: the Curator could not be recruited: ${String(err)}`);
    return null;
  });
  if (!curator || curator.templateId !== CURATOR_TEMPLATE_ID) return null;
  await store.addGezelToProject(projectId, curator.gezelId, { source: 'manual' }).catch(() => null);
  return { id: curator.gezelId, name: curator.name, created: curator.action !== 'reused' };
}

export interface AddedFolderDeps extends RecruitCrewDeps {
  tasks: TaskManager;
  chatEvents?: ChatEventBus;
  history?: HistoryManager;
}

export interface AddedFolderResult {
  crew: RecruitCrewResult;
  night: ArmNightWorkResult | null;
}

/**
 * Everything adding a folder sets up, in order: the crew (which decides the
 * folder's kind), then its resident night work. `nightWork: false` records
 * the folder's overnight switch as off instead of arming anything.
 */
export async function setUpAddedFolder(
  deps: AddedFolderDeps,
  projectId: string,
  opts: { nightWork?: boolean } = {},
): Promise<AddedFolderResult> {
  const crew = await recruitCrewForFolder(deps, projectId);
  if (crew.skipped && crew.skipped !== 'already-recruited') return { crew, night: null };
  if (opts.nightWork === false) {
    await setFolderNightWork(deps, projectId, false);
    return { crew, night: null };
  }
  const night = await armResidentNightWork(
    {
      store: deps.store,
      catalog: deps.catalog,
      tasks: deps.tasks,
      ...(deps.chatEvents ? { chatEvents: deps.chatEvents } : {}),
      ...(deps.history ? { history: deps.history } : {}),
      providerForGezel: (gezelId, o) => deps.chat.providerForGezel(gezelId, o),
    },
    projectId,
  ).catch((err: unknown) => {
    log.warn(`[projects] ${projectId}: arming night work failed: ${String(err)}`);
    return null;
  });
  return { crew, night };
}
