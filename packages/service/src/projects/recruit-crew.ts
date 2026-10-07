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
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { ensureDefaultBoekwachter } from '../gezels/autonomous-roles.js';
import { scanFolderProfile } from '../project-type/scan-folder.js';
import {
  type EnsureProjectLeadResult,
  ensureFolderProjectBuilder,
  ensureProjectVoorman,
} from '../workspace/import-sync.js';

const log = createLogger('projects');

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
 * fixes); pictures, documents and mixed folders are led by the Boekwachter, so
 * a Documents folder never gets a developer drafting edits to Word files.
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
    // Replace only a lead gezel seated on its own, never one the person chose.
    await store.updateProject(projectId, {
      voormanGezelId: boekwachter.id,
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
