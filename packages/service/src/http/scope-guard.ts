import type { Context, MiddlewareHandler } from 'hono';

/**
 * Per-session token scope enforcement (security review #10).
 *
 * A gezel's MCP subprocess authenticates with an ephemeral token scoped to
 * its session's `{projectId, gezelId}` (see token-store `issueSession`).
 * This guard confines such a token to `/api/projects/<projectId>/*` — so
 * even if the subprocess emitted a foreign `:id` (a bug, or a model-supplied
 * cross-project arg), the daemon refuses it. It's the server-side backstop
 * the confinement previously lacked.
 *
 * Tokens with NO project binding (root / ui; app/device tokens are rejected
 * by the preceding internal-API guard) are unrestricted here. Coordinator sessions
 * carry `team` and may reach any project (the Meester/voorman/planner
 * legitimately orchestrate across the crew).
 *
 * Three guards live here:
 *  - {@link projectScopeGuard} (increment 1) — the project-item boundary on
 *    `/api/projects/:id/*`. Defaults to ENFORCE (`GEZEL_TOKEN_SCOPE`).
 *  - {@link teamRouteGuard} (increment 2) — denies a NON-coordinator session
 *    the team/orchestration routes (create/message gezels, create projects +
 *    tasks, cross-gezel asks). Defaults to ENFORCE (`GEZEL_TEAM_SCOPE`).
 *  - {@link gezelScopeGuard} (increment 3) — confines a NON-coordinator
 *    session to its OWN gezel's identity/private state (so a prompt-injected
 *    worker can't read/act-as another gezel via a path/query/body gezelId).
 *    Coordinators bypass (they read the crew to delegate). Defaults to
 *    ENFORCE (`GEZEL_IDENTITY_SCOPE`).
 */
export type TokenScopeMode = 'enforce' | 'audit' | 'off';

type SessionAuth = {
  appId: string;
  scopes: readonly string[];
  projectId: string;
  gezelId: string;
  team?: boolean;
};

/**
 * Deny-by-default route policy for the bearer passed to a session's builtin
 * MCP subprocess. Project/identity prefix guards are necessary but not
 * sufficient: an HTTP route can select another scope through a query, body,
 * or opaque session id, and install-global routes have no project prefix at
 * all. Keep that subprocess on the MCP back-channel it actually needs.
 *
 * Root/UI tokens bypass this middleware. A `team` session gets the explicitly
 * cross-project coordinator routes, but it is still not a UI/admin credential:
 * config, raw sessions/events, terminal shells, engine administration, etc.
 * remain unavailable.
 */
export function sessionRouteGuard(opts: { log?: (msg: string) => void } = {}): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.get('auth');
    if (!raw?.scopes.includes('session')) return next();
    if (!raw.projectId || !raw.gezelId || !raw.appId.startsWith('session:')) {
      return denySessionRoute(c, opts, 'malformed session token binding');
    }
    const auth: SessionAuth = {
      appId: raw.appId,
      scopes: raw.scopes,
      projectId: raw.projectId,
      gezelId: raw.gezelId,
      ...(raw.team !== undefined ? { team: raw.team } : {}),
    };
    const allowed = await isSessionRouteAllowed(c, auth);
    if (!allowed.ok) return denySessionRoute(c, opts, allowed.reason);
    return next();
  };
}

type SessionRouteDecision = { ok: true } | { ok: false; reason: string };
const SESSION_ALLOW: SessionRouteDecision = { ok: true };

function sessionDeny(reason: string): SessionRouteDecision {
  return { ok: false, reason };
}

function sessionId(auth: SessionAuth): string {
  return auth.appId.slice('session:'.length);
}

function sameScopeValue(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && actual === expected;
}

function bodyUsesOwnScope(
  body: Record<string, unknown> | null,
  auth: SessionAuth,
  opts: { project?: boolean; gezel?: boolean; session?: boolean } = {},
): boolean {
  if (!body) return false;
  if (opts.project && !sameScopeValue(body.projectId, auth.projectId)) return false;
  if (opts.gezel && !sameScopeValue(body.gezelId, auth.gezelId)) return false;
  if (opts.session && !sameScopeValue(body.sessionId, sessionId(auth))) return false;
  return true;
}

function queryUsesOwnHistoryScope(c: Context, auth: SessionAuth): boolean {
  return c.req.query('project') === auth.projectId && c.req.query('gezel') === auth.gezelId;
}

async function isSessionRouteAllowed(c: Context, auth: SessionAuth): Promise<SessionRouteDecision> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();

  // Event streams expose live content for opaque session/project ids and are
  // renderer concerns, never an MCP back-channel requirement.
  if (path.startsWith('/events/')) return sessionDeny('session tokens cannot subscribe to events');
  if (!path.startsWith('/api/')) return sessionDeny('route is outside the session API surface');
  if (path.includes('//')) return sessionDeny('non-canonical API paths are not session routes');

  // These are collection-level renderer workflows, not project ids. Without
  // this check the generic `/api/projects/:id` classifier below interprets
  // e.g. `preview-folder` as an id and a team session bypasses the project
  // mismatch check. `preview-folder` is especially sensitive because it can
  // inspect an arbitrary host path supplied by the caller.
  if (
    path === '/api/projects/preview-about' ||
    path === '/api/projects/preview-folder' ||
    path === '/api/projects/poisoned'
  ) {
    return sessionDeny('project preview/status routes require a first-party client');
  }

  // Project item routes are the main MCP surface. Bind to the token's project
  // (coordinator sessions may intentionally cross projects), then remove UI-
  // only escape hatches that turn the scoped bearer into a human terminal or
  // expose another session's transcript/images.
  const projectMatch = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (projectMatch) {
    const targetProject = projectMatch[1]!;
    const rest = projectMatch[2] ?? '';
    if (!auth.team && targetProject !== auth.projectId) {
      return sessionDeny(`project ${targetProject} is outside the token scope`);
    }
    if (/^\/terminals(?:\/|$)/.test(rest)) {
      return sessionDeny('terminal routes require a first-party client');
    }
    if (rest === '/preview-capability' || rest === '/preview-capability/') {
      return sessionDeny('preview capabilities require a first-party client');
    }
    if (rest === '/tools' || rest === '/tools/') {
      return sessionDeny('the unfiltered human terminal tool list is not a session route');
    }
    if (rest === '/timeline' || rest === '/timeline/') {
      return sessionDeny('project timelines contain other sessions');
    }
    const projectSession = /^\/sessions\/([^/]+)(?:\/|$)/.exec(rest);
    if (projectSession && projectSession[1] !== sessionId(auth)) {
      return sessionDeny('session attachment route targets another session');
    }

    // Bind provenance fields to the credential instead of trusting the MCP
    // caller to self-identify. These routes use the fields for write journals,
    // approval questions, and command history; accepting another gezel/session
    // lets a stolen worker token forge audit records or route a prompt to a
    // different session. First-party UI calls bypass this policy and may omit
    // the fields as before.
    if (
      method !== 'GET' &&
      /^\/(?:workspace\/(?:copy-from-artifact|fetch-repo|fetch-diff|file|replace|replace-lines|patch|insert-at-marker|mkdir|rename)|npm-install|run-package-script|run-npx)\/?$/.test(
        rest,
      )
    ) {
      const body = await readJsonSafe(c);
      if (!bodyUsesOwnScope(body, auth, { gezel: true, session: true })) {
        return sessionDeny('project action attribution does not match the session token');
      }
    }
    if (method === 'DELETE' && rest === '/workspace/path') {
      if (c.req.query('gezelId') !== auth.gezelId || c.req.query('sessionId') !== sessionId(auth)) {
        return sessionDeny('workspace delete attribution does not match the session token');
      }
    }
    if (
      (method === 'POST' || method === 'PATCH' || method === 'DELETE') &&
      /^\/tasks\/[^/]+\/notes(?:\/[^/]+)?\/?$/.test(rest) &&
      c.req.header('x-gezel-actor') !== auth.gezelId
    ) {
      return sessionDeny('task-note actor does not match the session token');
    }

    // Project metadata, roster/import, and UI shell actions are coordinator
    // operations. Ordinary workers retain workspace/artifact/task-progress,
    // script, GitHub, connector, and project-tool routes inside their project.
    if (
      rest === '' ||
      rest === '/' ||
      /^\/(?:working-dir|reveal|clear-errors|apply-project-type|export-project-type|import-project-type)(?:\/|$)/.test(
        rest,
      ) ||
      /^\/(?:gezels|local-gezels|imports)(?:\/|$)/.test(rest) ||
      (method === 'POST' && /^\/tasks\/?$/.test(rest)) ||
      (method === 'POST' && /^\/tasks\/[^/]+\/spawn\/?$/.test(rest))
    ) {
      if ((rest === '' || rest === '/') && method === 'GET') return SESSION_ALLOW;
      if ((rest === '' || rest === '/') && method === 'DELETE') {
        return sessionDeny('deleting a project requires a first-party client');
      }
      return auth.team ? SESSION_ALLOW : sessionDeny('route requires a coordinator session');
    }
    return SESSION_ALLOW;
  }

  // Bare project collection is only needed by coordinator tools
  // (`list_projects`, `start_project`, `start_job`).
  if (path === '/api/projects' || path === '/api/projects/') {
    return auth.team && (method === 'GET' || method === 'POST')
      ? SESSION_ALLOW
      : sessionDeny('project collection requires a coordinator session');
  }

  // Gezel roster reads and `ensure_gezel` support delegation. Identity state
  // is otherwise own-gezel only; metadata mutations remain coordinator-only.
  if (path === '/api/gezels' || path === '/api/gezels/') {
    if (method === 'GET') return SESSION_ALLOW;
    return auth.team
      ? SESSION_ALLOW
      : sessionDeny('creating gezels requires a coordinator session');
  }
  if (path === '/api/gezels/ensure' && method === 'POST') return SESSION_ALLOW;
  if (path === '/api/gezels/mention-candidates' && method === 'GET') {
    return sessionDeny('mention candidates are a first-party composer route');
  }
  if (path === '/api/gezels/reset-templates') {
    return auth.team ? SESSION_ALLOW : sessionDeny('template reset requires a coordinator session');
  }
  const gezelMatch = /^\/api\/gezels\/([^/]+)(\/.*)?$/.exec(path);
  if (gezelMatch) {
    const targetGezel = gezelMatch[1]!;
    const rest = gezelMatch[2] ?? '';
    if (rest === '/message' && method === 'POST') {
      const body = await readJsonSafe(c);
      return (auth.team || body?.projectId === auth.projectId) &&
        body?.fromGezelId === auth.gezelId &&
        body?.fromSessionId === sessionId(auth)
        ? SESSION_ALLOW
        : sessionDeny('message origin does not match the session token');
    }
    if (!auth.team && targetGezel !== auth.gezelId) {
      return sessionDeny(`gezel ${targetGezel} is outside the token scope`);
    }
    if (!auth.team && (rest === '/timeline' || rest === '/projects')) {
      return sessionDeny('route exposes sessions/projects outside the token scope');
    }
    if (method === 'GET') return SESSION_ALLOW;
    return auth.team ? SESSION_ALLOW : sessionDeny('gezel mutation requires a coordinator session');
  }

  // Memory calls carry their scope outside the path. Enforce both axes here.
  if (path.startsWith('/api/memory/')) {
    if (path === '/api/memory/day' && method === 'PATCH') {
      return sessionDeny('editing raw memory files requires a first-party client');
    }
    if (auth.team) return SESSION_ALLOW;
    if (path === '/api/memory/search' && method === 'POST') {
      const body = await readJsonSafe(c);
      return bodyUsesOwnScope(body, auth, { project: true, gezel: true })
        ? SESSION_ALLOW
        : sessionDeny('memory search scope does not match the session');
    }
    if (path === '/api/memory/save' && method === 'POST') {
      const body = await readJsonSafe(c);
      const own =
        (body?.scope === 'project' && body.id === auth.projectId) ||
        (body?.scope === 'gezel' && body.id === auth.gezelId);
      return own ? SESSION_ALLOW : sessionDeny('memory write scope does not match the session');
    }
    if (method === 'GET' && /^\/api\/memory\/(?:recent|days|day|summary)$/.test(path)) {
      const scope = c.req.query('scope') ?? 'gezel';
      const id = c.req.query('id') ?? '';
      const own =
        (scope === 'project' && id === auth.projectId) ||
        (scope === 'gezel' && id === auth.gezelId);
      return own ? SESSION_ALLOW : sessionDeny('memory read scope does not match the session');
    }
    if (path === '/api/memory/lessons') {
      return c.req.query('gezelId') === auth.gezelId
        ? SESSION_ALLOW
        : sessionDeny('memory lessons target another gezel');
    }
    return sessionDeny('unknown memory route');
  }

  // The shared documents library is an intentional cross-project MCP
  // capability. Do not, however, let its fuzzy `projects/<id>/...` read
  // fallback become a side door into project documents/artifacts.
  if (path === '/api/documents' || path.startsWith('/api/documents/')) {
    if (
      path === '/api/documents/read' &&
      (c.req.query('path') ?? '').replaceAll('\\', '/').startsWith('projects/')
    ) {
      return sessionDeny('project documents must use the scoped project API');
    }
    return SESSION_ALLOW;
  }

  // Transcript/history search is useful to the memory tool, but a worker must
  // state both of its bindings. Omitting filters would search every session.
  if (path === '/api/history' && method === 'GET') {
    return auth.team || queryUsesOwnHistoryScope(c, auth)
      ? SESSION_ALLOW
      : sessionDeny('history search must be scoped to this project and gezel');
  }
  if (path === '/api/sessions/search' && method === 'GET') {
    return auth.team || queryUsesOwnHistoryScope(c, auth)
      ? SESSION_ALLOW
      : sessionDeny('session search must be scoped to this project and gezel');
  }
  if (path === '/api/sessions' || path.startsWith('/api/sessions/')) {
    return sessionDeny('raw session routes require a first-party client');
  }

  // Question/permission bridges are synchronous MCP workflows. Bind every
  // caller-supplied identity field to the token so one session cannot create
  // or wait on another session's prompt.
  if (path === '/api/questions' && method === 'POST') {
    const body = await readJsonSafe(c);
    return bodyUsesOwnScope(body, auth, { project: true, gezel: true, session: true })
      ? SESSION_ALLOW
      : sessionDeny('question scope does not match the session');
  }
  if (path === '/api/permissions/request-and-wait' && method === 'POST') {
    const body = await readJsonSafe(c);
    return bodyUsesOwnScope(body, auth, { project: true, gezel: true, session: true })
      ? SESSION_ALLOW
      : sessionDeny('permission scope does not match the session');
  }
  if (path.startsWith('/api/questions') || path.startsWith('/api/permissions')) {
    return sessionDeny('question administration requires a first-party client');
  }

  // Cross-gezel consultation is allowed only when the request proves it
  // originated from the bound session.
  if (path === '/api/asks/request-and-wait' && method === 'POST') {
    const body = await readJsonSafe(c);
    return (auth.team || body?.projectId === auth.projectId) &&
      body?.fromGezelId === auth.gezelId &&
      body?.fromSessionId === sessionId(auth)
      ? SESSION_ALLOW
      : sessionDeny('ask origin does not match the session token');
  }

  if ((path === '/api/tasks' || path === '/api/tasks/') && method === 'GET') {
    return auth.team ? SESSION_ALLOW : sessionDeny('global task listing requires a coordinator');
  }

  // Explicit install-global MCP capabilities. Local craftbook templates are
  // intentionally shared, while the same router also accepts `projectId` in
  // query/body to address project-local books. Bind that optional selector:
  // otherwise a worker can read or overwrite another project's craftbook by
  // avoiding the normal `/api/projects/:id/*` path boundary entirely.
  if (path === '/api/craftbooks' || path.startsWith('/api/craftbooks/')) {
    if (auth.team) return SESSION_ALLOW;
    const queryProjectId = c.req.query('projectId');
    if (queryProjectId !== undefined && queryProjectId !== auth.projectId) {
      return sessionDeny(`craftbook project ${queryProjectId} is outside the token scope`);
    }
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const body = await readJsonSafe(c);
      if (body?.projectId !== undefined && body.projectId !== auth.projectId) {
        return sessionDeny('craftbook body targets a project outside the token scope');
      }
    }
    return SESSION_ALLOW;
  }
  if (path.startsWith('/api/catalog/') && method === 'GET') {
    return auth.team ? SESSION_ALLOW : sessionDeny('catalog discovery requires a coordinator');
  }
  if (
    auth.team &&
    method === 'POST' &&
    /^\/api\/catalog\/gezel-template\/[^/]+\/install$/.test(path)
  ) {
    return SESSION_ALLOW;
  }
  if (auth.team && method === 'POST' && /^\/api\/catalog\/toolset\/[^/]+\/install$/.test(path)) {
    const body = await readJsonSafe(c);
    const scope = body?.scope as Record<string, unknown> | undefined;
    return scope?.kind === 'project' && typeof scope.projectId === 'string'
      ? SESSION_ALLOW
      : sessionDeny('session toolset installs must be project-scoped');
  }
  if (
    auth.team &&
    method === 'POST' &&
    /^\/api\/catalog\/toolset\/[^/]+\/request-install-and-wait$/.test(path)
  ) {
    const body = await readJsonSafe(c);
    const scope = body?.scope as Record<string, unknown> | undefined;
    return scope?.kind === 'project' &&
      typeof scope.projectId === 'string' &&
      body?.gezelId === auth.gezelId &&
      body?.sessionId === sessionId(auth)
      ? SESSION_ALLOW
      : sessionDeny('toolset request origin does not match the session token');
  }
  if (/^\/api\/scripts\/standard(?:\/source)?$/.test(path) && method === 'GET') {
    return SESSION_ALLOW;
  }

  // Media/render tools are model-facing, but their project binding is in the
  // body rather than the URL. Only generation calls are admitted; model/admin
  // listing, pull, deletion, and engine-status routes stay first-party.
  if (
    (path === '/api/render/image' ||
      path === '/api/image-gen/generate' ||
      path === '/api/video-gen/generate' ||
      path === '/api/audio/transcribe' ||
      path === '/api/audio/synthesize') &&
    method === 'POST'
  ) {
    const body = await readJsonSafe(c);
    return bodyUsesOwnScope(body, auth, { project: true }) &&
      (body?.gezelId === undefined || body.gezelId === auth.gezelId) &&
      (body?.sessionId === undefined || body.sessionId === sessionId(auth))
      ? SESSION_ALLOW
      : sessionDeny('media request scope does not match the session');
  }

  return sessionDeny('route is not part of the session MCP API');
}

function denySessionRoute(c: Context, opts: { log?: (msg: string) => void }, reason: string) {
  const auth = c.get('auth');
  opts.log?.(
    `[session-route] DENY session=${auth?.appId ?? 'unknown'} ${c.req.method} ${c.req.path}: ${reason}`,
  );
  return c.json({ error: 'forbidden', hint: reason }, 403);
}

/** Resolve the `GEZEL_TOKEN_SCOPE` env into a mode. Default: enforce. */
export function resolveTokenScopeMode(raw: string | undefined): TokenScopeMode {
  if (raw === 'audit') return 'audit';
  if (raw === 'off') return 'off';
  return 'enforce';
}

/** Resolve the `GEZEL_TEAM_SCOPE` env into a mode. Default: enforce. */
export function resolveTeamScopeMode(raw: string | undefined): TokenScopeMode {
  if (raw === 'audit') return 'audit';
  if (raw === 'off') return 'off';
  return 'enforce';
}

/** Resolve the `GEZEL_IDENTITY_SCOPE` env into a mode. Default: enforce. */
export function resolveIdentityScopeMode(raw: string | undefined): TokenScopeMode {
  if (raw === 'audit') return 'audit';
  if (raw === 'off') return 'off';
  return 'enforce';
}

/**
 * Extract the project id segment from `/api/projects/<id>/...`. Returns null
 * for the bare collection (`/api/projects`, `/api/projects/`) — that's a
 * team/global route, not a project-item route, so it isn't guarded here.
 */
export function projectIdFromPath(path: string): string | null {
  const m = /^\/api\/projects\/([^/]+)(?:\/|$)/.exec(path);
  return m?.[1] ? m[1] : null;
}

export function projectScopeGuard(opts: {
  mode: TokenScopeMode;
  log?: (msg: string) => void;
}): MiddlewareHandler {
  return async (c, next) => {
    if (opts.mode === 'off') return next();
    const auth = c.get('auth');
    // No project binding → root / ui / app token → unrestricted here.
    if (!auth?.projectId) return next();
    // Coordinator session → may operate across projects.
    if (auth.team) return next();
    const id = projectIdFromPath(c.req.path);
    if (id === null) return next(); // collection / non-item route
    if (id === auth.projectId) return next(); // own project
    const verb = opts.mode === 'audit' ? 'WOULD-DENY' : 'DENY';
    opts.log?.(
      `[token-scope] ${verb} session=${auth.appId} scopedProject=${auth.projectId} path=${c.req.path}`,
    );
    if (opts.mode === 'audit') return next();
    return c.json(
      { error: `forbidden: token is scoped to project "${auth.projectId}", not "${id}"` },
      403,
    );
  };
}

/**
 * Team/orchestration routes a NON-coordinator (`team:false`) session must
 * not reach. Matchers are method-specific on purpose: a worker legitimately
 * GETs its own gezel/project and writes task notes/status/steps, but never
 * creates/messages gezels, creates projects/tasks, or runs a cross-gezel
 * ask. A worker's MCP subprocess was verified never to call these in its
 * normal flow (the corresponding tools are role-gated to coordinators), so
 * gating them is a pure server-side backstop. Routes NOT listed here stay
 * open — a missed team route is low marginal risk (the surface filter
 * already keeps the tool off a worker), so we err away from false-positives
 * that would break a worker. Anything genuinely missed surfaces in audit
 * logs before enforce is enabled.
 */
const TEAM_ROUTE_MATCHERS: ReadonlyArray<{ methods: readonly string[]; re: RegExp }> = [
  // Gezel orchestration: create / ensure / reset / message / mutate metadata.
  { methods: ['POST'], re: /^\/api\/gezels\/?$/ },
  { methods: ['DELETE'], re: /^\/api\/gezels\/[^/]+\/?$/ },
  { methods: ['POST'], re: /^\/api\/gezels\/ensure\/?$/ },
  { methods: ['POST'], re: /^\/api\/gezels\/reset-templates\/?$/ },
  { methods: ['POST'], re: /^\/api\/gezels\/[^/]+\/message\/?$/ },
  {
    methods: ['POST', 'PUT'],
    re: /^\/api\/gezels\/[^/]+\/(rename|about|settings|md|icon|poppetje)\/?$/,
  },
  // Cross-gezel consultation (ask_gezel).
  { methods: ['POST', 'PUT', 'DELETE'], re: /^\/api\/asks(?:\/|$)/ },
  // Project create / update / delete / roster mutation.
  { methods: ['POST'], re: /^\/api\/projects\/?$/ },
  { methods: ['PUT', 'DELETE'], re: /^\/api\/projects\/[^/]+\/?$/ },
  { methods: ['POST'], re: /^\/api\/projects\/[^/]+\/gezels\/?$/ },
  { methods: ['DELETE'], re: /^\/api\/projects\/[^/]+\/gezels\/[^/]+\/?$/ },
  // Task orchestration: create + spawn. NOT notes/status/steps (worker progress).
  { methods: ['POST'], re: /^\/api\/projects\/[^/]+\/tasks\/?$/ },
  { methods: ['POST'], re: /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/spawn\/?$/ },
  // Cross-project task visibility (global list_tasks with no project filter).
  { methods: ['GET'], re: /^\/api\/tasks(?:\/|$)/ },
];

/** True when (method, path) is a team/orchestration route per the matchers. */
export function isTeamRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  for (const matcher of TEAM_ROUTE_MATCHERS) {
    if (matcher.methods.includes(m) && matcher.re.test(path)) return true;
  }
  return false;
}

export function teamRouteGuard(opts: {
  mode: TokenScopeMode;
  log?: (msg: string) => void;
}): MiddlewareHandler {
  return async (c, next) => {
    if (opts.mode === 'off') return next();
    const auth = c.get('auth');
    if (!auth?.projectId) return next(); // root / ui / app token
    if (auth.team) return next(); // coordinator session
    if (!isTeamRoute(c.req.method, c.req.path)) return next();
    const verb = opts.mode === 'audit' ? 'WOULD-DENY' : 'DENY';
    opts.log?.(
      `[team-scope] ${verb} session=${auth.appId} scopedProject=${auth.projectId} ${c.req.method} ${c.req.path}`,
    );
    if (opts.mode === 'audit') return next();
    return c.json(
      { error: 'forbidden: this team/orchestration route requires a coordinator session' },
      403,
    );
  };
}

async function readJsonSafe(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The gezel a request targets — from the path (`/api/gezels/:id/...`), a
 * `?gezel=`/`?id=` query, or the JSON body (memory `search`/`save`, `POST
 * /api/sessions`). Returns null when the route names no gezel, so the guard
 * leaves it alone. The body is read ONLY for the few POST routes that carry
 * a gezelId there — and the guard only calls this for session tokens (it
 * short-circuits root/ui first), so it never touches the body of an
 * unrelated request (e.g. every existing root-token caller).
 */
export async function targetGezelId(c: Context): Promise<string | null> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();

  // /api/gezels/:id/... — :id is the gezel whose identity/state is touched.
  const gm = /^\/api\/gezels\/([^/]+)(\/.*)?$/.exec(path);
  if (gm) {
    const id = gm[1]!;
    const rest = gm[2] ?? '';
    // Collection-level segments aren't gezel ids.
    if (id === 'ensure' || id === 'reset-templates' || id === 'mention-candidates') return null;
    // `/message` addresses a RECIPIENT, not the caller's identity — the team
    // guard owns that route, so leave it (avoids double-handling).
    if (rest === '/message') return null;
    return id;
  }

  // Memory — gezel-scoped reads/writes (scope='gezel' → the id IS a gezelId).
  if (path === '/api/memory/lessons') return c.req.query('gezelId') || null;
  if (path === '/api/memory/search' && method === 'POST') {
    const b = await readJsonSafe(c);
    return typeof b?.gezelId === 'string' ? b.gezelId : null;
  }
  if (path === '/api/memory/save' && method === 'POST') {
    const b = await readJsonSafe(c);
    return b?.scope === 'gezel' && typeof b.id === 'string' ? b.id : null;
  }
  if (/^\/api\/memory\/(recent|days|day|summary)$/.test(path)) {
    return (c.req.query('scope') ?? 'gezel') === 'gezel' ? c.req.query('id') || null : null;
  }

  // Sessions — listing/creation filtered by gezel.
  if (path === '/api/sessions' && method === 'POST') {
    const b = await readJsonSafe(c);
    return typeof b?.gezelId === 'string' ? b.gezelId : null;
  }
  if (path === '/api/sessions' || path.startsWith('/api/sessions/inflight')) {
    return c.req.query('gezel') || null;
  }

  // Timeline + history — filtered by gezel via ?gezel=.
  if (
    path === '/api/timeline' ||
    path === '/api/history' ||
    /^\/api\/projects\/[^/]+\/timeline$/.test(path)
  ) {
    return c.req.query('gezel') || null;
  }

  return null;
}

export function gezelScopeGuard(opts: {
  mode: TokenScopeMode;
  log?: (msg: string) => void;
}): MiddlewareHandler {
  return async (c, next) => {
    if (opts.mode === 'off') return next();
    const auth = c.get('auth');
    if (!auth?.gezelId) return next(); // root / ui / app token (no gezel binding)
    if (auth.team) return next(); // coordinator session reads/orchestrates the crew
    const target = await targetGezelId(c);
    if (target === null || target === auth.gezelId) return next();
    const verb = opts.mode === 'audit' ? 'WOULD-DENY' : 'DENY';
    opts.log?.(
      `[gezel-scope] ${verb} session=${auth.appId} scopedGezel=${auth.gezelId} target=${target} ${c.req.method} ${c.req.path}`,
    );
    if (opts.mode === 'audit') return next();
    return c.json(
      { error: `forbidden: token is scoped to gezel "${auth.gezelId}", not "${target}"` },
      403,
    );
  };
}
