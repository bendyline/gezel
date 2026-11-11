import { type CreateProjectRequest, type ProjectDetail, createLogger } from '@bendyline/gezel';
import type { ServiceContext } from '../http/context.js';
import { detectAndPersistProjectType } from '../project-type/detect.js';
import {
  type EnsureProjectLeadResult,
  ensureProjectBuilder,
  ensureProjectVoorman,
} from '../workspace/import-sync.js';
import { setUpAddedFolder } from './recruit-crew.js';

const log = createLogger('projects');

export type CreateProjectDeps = Pick<
  ServiceContext,
  'store' | 'chat' | 'home' | 'catalog' | 'chatEvents' | 'git' | 'tasks' | 'history'
>;

/**
 * Create a project the way `POST /api/projects` always has: store record,
 * its main gezel up front, folder classification, the `project_created`
 * event, and a background clone for GitHub-linked projects. Shared by the
 * route and by folder inference so both entry points create identical
 * projects.
 *
 * A caller that names no shape and sends `autoMode` (the app's New project)
 * gets the one the install's default model works best in: a crew with a crew
 * lead for stepwise, one Builder working alone otherwise. The shape is
 * written on the project, so it stays when the model changes.
 */
export async function createProjectWithLead(
  deps: CreateProjectDeps,
  body: CreateProjectRequest,
): Promise<ProjectDetail> {
  const { recruitCrew: _recruitCrew, nightWork: _nightWork, autoMode, ...request } = body;
  const chosen =
    request.mode === undefined && autoMode
      ? await deps.chat.newProjectMode().catch((err) => {
          log.warn(`[projects] could not pick a shape for "${body.name}": ${String(err)}`);
          return undefined;
        })
      : undefined;
  const record = chosen ? { ...request, mode: chosen } : request;
  const created = await deps.store.createProject(record);
  // A folder the person added picks its lead by what it holds, after the
  // folder has been classified; see recruitCrewForFolder.
  const recruitCrew = body.recruitCrew === true && Boolean(body.workingDir);
  // Give the project its main gezel up front so Chat never opens on an
  // arbitrary alphabetical gezel. A solo project that is a folder, or whose
  // shape was picked here, gets a hands-on Builder; a crew project its
  // Voorman. Either is reused when the person already has one. A caller that
  // asked for a solo project by name seats its own. Runs synchronously
  // because both the CLI and desktop open Chat immediately. Best-effort;
  // never blocks creation.
  const ensureLead =
    record.mode === 'solo' && (body.workingDir || chosen)
      ? ensureProjectBuilder
      : ensureProjectVoorman;
  const ensured =
    body.lead === 'none' || recruitCrew
      ? ({} as EnsureProjectLeadResult)
      : await ensureLead(
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
  if (recruitCrew) {
    const setUp = await setUpAddedFolder(deps, created.id, {
      ...(body.nightWork !== undefined ? { nightWork: body.nightWork } : {}),
    }).catch((err: unknown) => {
      log.warn(`[projects] crew recruitment failed for ${created.id}: ${String(err)}`);
      return null;
    });
    for (const gezel of setUp?.crew.createdGezels ?? []) {
      deps.chatEvents.publishGlobalEvent({
        type: 'gezel_created',
        gezelId: gezel.id,
        name: gezel.name,
      });
    }
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
