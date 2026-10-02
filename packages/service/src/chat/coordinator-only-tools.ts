import { BUILTIN_TOOLSETS } from '@bendyline/gezel-catalog';
import { roleHasTeamScope } from './role-tool-filter.js';

/**
 * Built-in tools a NON-coordinator session can never complete, keyed by the
 * daemon route each one cannot work without.
 *
 * A session's MCP child calls back into the daemon with a token whose `team`
 * bit is `roleHasTeamScope(role, projectMode)`, and the session route guards
 * in `http/scope-guard.ts` (`sessionRouteGuard` + `teamRouteGuard`, both
 * mounted) refuse every route below to a token without it. Offering these
 * tools to a worker therefore advertises a call that is guaranteed to 403.
 * Wild-caught on craftbook-export-generalize (qwen3.8-27b): a Developer told
 * to save finished work as a recipe called `import_skill` 21 times, each
 * "forbidden: route requires a coordinator session", plus `invoke_craftbook`
 * and four escalation tools, and never reached a tool it could use.
 *
 * Only tools whose PRIMARY route is coordinator-only belong here. A tool with
 * a worker-legal main path keeps its slot even if one branch is refused
 * (`list_tasks` without a project, which falls back to the session's own
 * project; `ask_user_question`'s roster lookup).
 * `coordinator-only-tools-guard.test.ts` replays every route below through
 * the real guards and fails when the guard and this table disagree.
 */
export interface CoordinatorRouteProbe {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** `:project` / `:gezel` are the session's own; `:other` is another gezel. */
  readonly path: string;
  /** The request names the calling session as its origin (message / ask bodies). */
  readonly bindsOrigin?: true;
}

const ENSURE_GEZEL: CoordinatorRouteProbe = { method: 'POST', path: '/api/gezels/ensure' };
const ASK_GEZEL: CoordinatorRouteProbe = {
  method: 'POST',
  path: '/api/asks/request-and-wait',
  bindsOrigin: true,
};
const CREATE_TASK: CoordinatorRouteProbe = { method: 'POST', path: '/api/projects/:project/tasks' };
const CREATE_PROJECT: CoordinatorRouteProbe = { method: 'POST', path: '/api/projects' };

const NAMED_COORDINATOR_TOOL_ROUTES: Readonly<Record<string, readonly CoordinatorRouteProbe[]>> = {
  create_task: [CREATE_TASK],
  start_plan: [CREATE_TASK],
  invoke_craftbook: [{ method: 'GET', path: '/api/catalog/toolset/any' }, CREATE_TASK],
  import_skill: [{ method: 'POST', path: '/api/projects/:project/imports/convert' }],
  spawn_task_instances: [{ method: 'POST', path: '/api/projects/:project/tasks/1/spawn' }],
  ensure_gezel: [ENSURE_GEZEL],
  message_gezel: [{ method: 'POST', path: '/api/gezels/:other/message', bindsOrigin: true }],
  ask_gezel: [ASK_GEZEL],
  ask_specialist: [ENSURE_GEZEL, ASK_GEZEL],
  create_gezel: [{ method: 'POST', path: '/api/gezels' }],
  create_gezel_from_gilde: [{ method: 'POST', path: '/api/catalog/gezel-template/any/install' }],
  update_gezel: [
    { method: 'PUT', path: '/api/gezels/:gezel/about' },
    { method: 'POST', path: '/api/gezels/:gezel/settings' },
  ],
  list_gilde: [{ method: 'GET', path: '/api/catalog/gezel-template' }],
  list_projects: [{ method: 'GET', path: '/api/projects' }],
  start_project: [CREATE_PROJECT],
  start_job: [CREATE_PROJECT],
  start_project_from_type: [CREATE_PROJECT],
  fetch_repo: [CREATE_PROJECT],
  fetch_diff: [CREATE_PROJECT],
  update_project: [{ method: 'PUT', path: '/api/projects/:project' }],
  list_project_types: [{ method: 'GET', path: '/api/catalog/project-type' }],
  apply_project_type: [{ method: 'POST', path: '/api/projects/:project/apply-project-type' }],
  list_project_gezels: [{ method: 'GET', path: '/api/projects/:project/gezels' }],
  list_project_local_gezels: [{ method: 'GET', path: '/api/projects/:project/local-gezels' }],
  add_gezel_to_project: [{ method: 'POST', path: '/api/projects/:project/gezels' }],
  remove_gezel_from_project: [{ method: 'DELETE', path: '/api/projects/:project/gezels/:other' }],
};

/**
 * Every `delegate_<role>` / `consult_<role>` resolves its target with
 * `ensure_gezel` before anything else, so the whole role-delegation family —
 * including the escalation pair specialists are granted — is coordinator-only.
 */
const ROLE_DELEGATION_GROUPS: ReadonlySet<string> = new Set([
  'role-delegation',
  'role-delegation-escalation',
]);

export const COORDINATOR_ONLY_TOOL_ROUTES: Readonly<
  Record<string, readonly CoordinatorRouteProbe[]>
> = {
  ...Object.fromEntries(
    BUILTIN_TOOLSETS.filter((group) => ROLE_DELEGATION_GROUPS.has(group.id)).flatMap((group) =>
      group.tools.map((tool) => [tool, [ENSURE_GEZEL]] as const),
    ),
  ),
  ...NAMED_COORDINATOR_TOOL_ROUTES,
};

export const COORDINATOR_ONLY_TOOLS: ReadonlySet<string> = new Set(
  Object.keys(COORDINATOR_ONLY_TOOL_ROUTES),
);

/**
 * Whether this session's MCP token carries the coordinator (`team`) scope.
 * The same predicate, on the same inputs, that `ChatManager` mints the token
 * with — so the roster and the guard cannot disagree about who is a worker.
 */
export function sessionHasCoordinatorScope(
  role: string | undefined,
  projectMode: 'crew' | 'solo' | undefined,
): boolean {
  return roleHasTeamScope(role, projectMode);
}

/** Subtract the coordinator-only tools. `null` (unfiltered) is materialized first. */
export function withoutCoordinatorOnlyTools(
  allowlist: Set<string> | null,
  materializeUnfiltered: () => Set<string>,
): Set<string> {
  const source = allowlist ?? materializeUnfiltered();
  const next = new Set<string>();
  for (const name of source) if (!COORDINATOR_ONLY_TOOLS.has(name)) next.add(name);
  return next;
}
