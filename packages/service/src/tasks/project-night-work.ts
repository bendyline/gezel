import {
  type NightShiftWindow,
  createLogger,
  nightShiftDayKey,
  projectNightWorkEnabled,
} from '@bendyline/gezel';
import type { DiffpackManager } from '../diffpack/manager.js';
import { type NightFixPlannerDeps, planProjectNightFixes } from '../diffpack/night-fix-planner.js';
import type { Store } from '../fs/store.js';
import { writeNightlyCodebaseReport } from '../index-store/codebase-report.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { writeNightlyDocumentsReport } from '../index-store/documents-report.js';
import { albumMediaDeps, storeAllAlbumPhotos } from '../index-store/photo-albums.js';
import { writeNightlyPhotoReport } from '../index-store/photo-report.js';
import { writeNightlyCodeFolderFiles } from '../issue-triage/handoff-report.js';
import {
  type ObservationNightlyDeps,
  runProjectObservationNightly,
} from '../observations/nightly.js';

const log = createLogger('service');

export interface ProjectNightWorkDeps {
  store: Store;
  contentIndex: ContentIndex;
  diffpacks: DiffpackManager;
  nightFixes: NightFixPlannerDeps;
  observations: ObservationNightlyDeps;
  nightShiftWindow: () => NightShiftWindow;
  now?: () => Date;
}

/**
 * What a project gets once its slice of the night's index sweep is done: fix
 * planning against tonight's findings, observation upkeep, and the
 * model-free reports. Each part fails alone, so one bad report never costs
 * the project the rest of its night.
 */
export async function runProjectNightWork(
  deps: ProjectNightWorkDeps,
  projectId: string,
): Promise<void> {
  const { store, contentIndex } = deps;
  const project = await store.getProject(projectId);
  if (!project || !projectNightWorkEnabled(project)) return;
  const plan = await planProjectNightFixes(deps.nightFixes, projectId).catch((err) => {
    log.warn(`[diffpack] night fix planning failed for ${projectId}: ${String(err)}`);
    return null;
  });
  if (plan?.taskRef) {
    log.info(`[diffpack] night fixing planned for ${projectId} (${plan.issueCount} issue(s))`);
  }
  await runProjectObservationNightly(deps.observations, projectId).catch((err) =>
    log.warn(`[observations] nightly maintenance failed for ${projectId}: ${String(err)}`),
  );
  // Keyed to the night, not the clock: a night crossing midnight wrote
  // photos-10-07 and codebase-10-08 for the same run (2026-10-08).
  const now = deps.now?.() ?? new Date();
  const night = nightShiftDayKey(now, deps.nightShiftWindow());
  // Model-free, so it runs on any machine; writes nothing for a folder
  // without photos.
  await writeNightlyPhotoReport({ store, contentIndex }, projectId, now, night).catch((err) =>
    log.warn(`[index] photo report failed for ${projectId}: ${String(err)}`),
  );
  // Albums the night's craftbook wrote link workspace photos; store the
  // copies now so they play and export in the morning.
  await storeAllAlbumPhotos(albumMediaDeps(store), projectId).catch((err) =>
    log.warn(`[index] storing album photos failed for ${projectId}: ${String(err)}`),
  );
  await writeNightlyDocumentsReport({ store, contentIndex }, projectId, now, night).catch((err) =>
    log.warn(`[index] documents report failed for ${projectId}: ${String(err)}`),
  );
  await writeNightlyCodebaseReport({ store, contentIndex }, projectId, now, night).catch((err) =>
    log.warn(`[index] codebase report failed for ${projectId}: ${String(err)}`),
  );
  await writeNightlyCodeFolderFiles(
    { store, contentIndex, diffpacks: deps.diffpacks },
    projectId,
    now,
  );
}
