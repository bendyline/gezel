import {
  findGezelInRoster,
  findProjectByReference,
  gezelNotFoundMessage,
  gezelRosterHint,
  isSafeEntityId,
  projectNotFoundMessage,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { type TaskRefParts, resolveTaskRef } from './task-ref.js';

// ── id resolution for model-supplied project, gezel and task refs ────────

interface EntityResolverDependencies {
  api: Pick<GezelClient, 'getProject' | 'listProjects' | 'getGezel' | 'listGezels'>;
  projectId: string;
  sessionTaskRef: string;
}

export interface EntityResolvers {
  resolveProjectId(input: string, recoveryTools?: readonly string[]): Promise<string>;
  resolveGezelId(input: string): Promise<string>;
  availableGezelsHint(): Promise<string>;
  parseRef(ref: string): Promise<TaskRefParts>;
}

export function createEntityResolvers(deps: EntityResolverDependencies): EntityResolvers {
  const { api, projectId, sessionTaskRef } = deps;

  /**
   * Resolve whatever the model passed as a project reference to a real id.
   * Accepts the id directly OR a case-insensitive match against the
   * project's display name — models routinely reach for the pretty name
   * ("Pet Store Prototype") they see in the chat instead of the slug id
   * ("pet-store-prototype"). On total miss, throw a helpful error listing
   * the actual ids so the model can self-correct on the next tool call.
   */
  async function resolveProjectId(
    input: string,
    recoveryTools: readonly string[] = [],
  ): Promise<string> {
    try {
      const p = await api.getProject(input);
      return p.id;
    } catch {
      /* fall through to name lookup */
    }
    let all: Awaited<ReturnType<GezelClient['listProjects']>>['projects'];
    try {
      all = (await api.listProjects()).projects;
    } catch (err) {
      // Project-confined sessions (worker-scoped tokens) may not list
      // projects at all. The only project such a session can touch is its
      // own, so resolve any project arg — usually the current project's
      // display name — to the session scope instead of dying on the 403.
      // Wild-caught (craftbook-ship live-mock pilot): the model passed
      // `project: "Ship Eval"` and run_script 403'd on GET /api/projects.
      if (/\b403\b/.test(err instanceof Error ? err.message : String(err))) {
        return projectId;
      }
      throw err;
    }
    const match = findProjectByReference(all, input);
    if (match) return match.id;
    throw new Error(projectNotFoundMessage(input, all, recoveryTools));
  }

  /**
   * Resolve a gezel id-or-name to a canonical id: the roster is consulted
   * first (exact id, then a case-insensitive id / display name /
   * role-based name), and `getGezel` is the fallback for gezels the roster
   * does not list, such as the encoded project-local ids. Same shape as
   * `resolveProjectId` — kept terse here because tools that take a gezel
   * arg never need partial / fuzzy matching.
   *
   * The roster has to come first because `getGezel` echoes the id it was
   * asked for, and on a case-insensitive filesystem `getGezel("Ada")`
   * happily reads `gezels/ada/`. Returning "Ada" there would persist a
   * reference that no `===` against the real id matches — the drift
   * `ChatManager.resolveGezelIdRef` exists to undo.
   */
  async function resolveGezelId(input: string): Promise<string> {
    const all = (await api.listGezels()).gezels;
    const match = findGezelInRoster(all, input);
    if (match) return match.id;
    try {
      const g = await api.getGezel(input);
      return g.id;
    } catch {
      /* not a listed gezel and not directly readable */
    }
    throw new Error(gezelNotFoundMessage(input, all));
  }

  async function availableGezelsHint(): Promise<string> {
    try {
      return gezelRosterHint((await api.listGezels()).gezels);
    } catch {
      return 'Call `list_gezels` for the roster.';
    }
  }

  // Tolerant ref resolution: accepts the canonical `projectId/num` but
  // also recovers small-model mangles (`#`/`:` separators, stray
  // backticks, a truncated projectId) by falling back to the session's
  // own task. See `task-ref.ts` for the resolution order and the
  // wild-caught failures that motivated it.
  async function parseRef(ref: string): Promise<TaskRefParts> {
    const parsed = resolveTaskRef(ref, sessionTaskRef);
    // The projectId half of a ref gets the same tolerance every `project`
    // argument already gets. `resolveProjectId` exists because models reach
    // for the display name they see in chat instead of the slug, and ~40
    // tools honor that — but a ref went through verbatim, so
    // `list_tasks({ project: "PowerPoint Grounding Eval" })` worked while
    // `read_task_notes({ ref: "PowerPoint Grounding Eval/1" })` 400'd on
    // `invalid entity id` with no remedy in the message. Observed in 11
    // distinct eval sessions; each one stopped using the task tools
    // entirely afterwards. Only refs whose project half cannot be an id at
    // all pay the extra lookup.
    if (isSafeEntityId(parsed.projectId)) return parsed;
    return { ...parsed, projectId: await resolveProjectId(parsed.projectId) };
  }

  return { resolveProjectId, resolveGezelId, availableGezelsHint, parseRef };
}
