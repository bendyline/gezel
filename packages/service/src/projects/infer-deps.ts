import type { CreateProjectRequest } from '@bendyline/gezel';
import type { ServiceContext } from '../http/context.js';
import { createProjectWithLead } from './create-project.js';
import type { InferProjectDeps } from './infer-project.js';
import { setUpAddedFolder } from './recruit-crew.js';

/**
 * The daemon's own dependencies for folder inference. One factory, shared by
 * `POST /api/projects/infer-for-path` and every server-side caller that binds
 * a folder to a project, so they create identical projects.
 */
export function buildInferDeps(
  ctx: ServiceContext,
  opts: { nightWork?: boolean } = {},
): InferProjectDeps {
  return {
    store: ctx.store,
    home: ctx.home,
    history: ctx.history,
    createProject: (body: CreateProjectRequest) => createProjectWithLead(ctx, body),
    recruitCrew: async (projectId: string) => {
      const { crew } = await setUpAddedFolder(ctx, projectId, opts);
      for (const gezel of crew.createdGezels) {
        ctx.chatEvents.publishGlobalEvent({
          type: 'gezel_created',
          gezelId: gezel.id,
          name: gezel.name,
        });
      }
    },
  };
}
