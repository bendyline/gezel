import { type CreateProjectRequest, type ProjectDetail, createLogger } from '@bendyline/gezel';
import type { ServiceContext } from '../http/context.js';
import { detectAndPersistProjectType } from '../project-type/detect.js';
import {
  type EnsureProjectLeadResult,
  ensureFolderProjectBuilder,
  ensureProjectVoorman,
} from '../workspace/import-sync.js';

const log = createLogger('projects');

export type CreateProjectDeps = Pick<
  ServiceContext,
  'store' | 'chat' | 'home' | 'catalog' | 'chatEvents' | 'git'
>;

/**
 * Create a project the way `POST /api/projects` always has: store record,
 * a lead gezel up front, folder classification, the `project_created`
 * event, and a background clone for GitHub-linked projects. Shared by the
 * route and by folder inference so both entry points create identical
 * projects.
 */
export async function createProjectWithLead(
  deps: CreateProjectDeps,
  body: CreateProjectRequest,
): Promise<ProjectDetail> {
  const created = await deps.store.createProject(body);
  // Give the project its lead up front so Chat never opens on an arbitrary
  // alphabetical gezel. Folder-backed solo projects get a hands-on Builder;
  // crew projects retain their Voorman. Runs synchronously because both the
  // CLI and desktop open Chat immediately. Best-effort; never blocks creation.
  const ensureLead =
    body.workingDir && body.mode === 'solo' ? ensureFolderProjectBuilder : ensureProjectVoorman;
  const ensured = await ensureLead(
    { store: deps.store, chat: deps.chat, home: deps.home, catalog: deps.catalog },
    created.id,
  ).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[projects] ensure-lead failed for ${created.id}: ${message}`);
    return {} as EnsureProjectLeadResult;
  });
  if (ensured.createdGezel) {
    deps.chatEvents.publishGlobalEvent({
      type: 'gezel_created',
      gezelId: ensured.createdGezel.id,
      name: ensured.createdGezel.name,
    });
  }
  // Classify a folder-backed project up front, off a bounded static scan of
  // the directory. The index tick would get here eventually, but not for the
  // first session: opening a folder and immediately asking "what should I
  // build?" is exactly when the craftbook shortlist and the gezel-role
  // suggestions need to know whether this is code, prose, data, or assets.
  if (body.workingDir) {
    await detectAndPersistProjectType({ store: deps.store }, created.id);
  }
  // Re-read so the response carries the freshly-set voormanGezelId and
  // detected type; the UI selects the project from this payload and opens
  // Chat on the lead.
  const project = (await deps.store.getProject(created.id)) ?? created;
  // Announce the new project on the project + global SSE streams so
  // always-mounted surfaces (the left sidebar PROJECTS list) fold it in
  // immediately. History-free so it isn't replayed to late subscribers.
  deps.chatEvents.publishProjectEvent(project.id, {
    type: 'project_created',
    projectId: project.id,
    name: project.name,
  });
  // A GitHub-linked project clones in the background; the dialog has already
  // closed. Failures land in the service log, and the checkout's status is
  // observable through GET /api/projects/:id/git/status.
  if (project.github?.url) {
    void deps.git.ensureClone(project).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[projects] background clone failed for ${project.id}: ${message}`);
    });
  }
  return project;
}
