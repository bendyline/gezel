import { readFileSync } from 'node:fs';
import { TOOL_REGISTRY } from '@bendyline/gezel-mcp';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sessionRouteGuard, teamRouteGuard } from '../http/scope-guard.js';
import {
  COORDINATOR_ONLY_TOOLS,
  COORDINATOR_ONLY_TOOL_ROUTES,
  type CoordinatorRouteProbe,
} from './coordinator-only-tools.js';

/**
 * The guard half of the worker/coordinator contract. Every route in
 * COORDINATOR_ONLY_TOOL_ROUTES is replayed through the guards exactly as
 * server.ts mounts them, and every coordinator-only branch of scope-guard.ts
 * must be claimed by a tool or listed below as reached by none. A new
 * branch, a relaxed one, or a renamed tool fails here, not in an eval.
 */

const PROJECT = 'proj-a';
const GEZEL = 'gz-1';
const SESSION = 'sess-1';
const OTHER = 'gz-2';

/** Coordinator-only routes no model tool depends on. */
const UNTOOLED_COORDINATOR_ROUTES: ReadonlyArray<{ probe: CoordinatorRouteProbe; why: string }> = [
  {
    probe: { method: 'PUT', path: '/api/projects/:project/working-dir' },
    why: 'project folder setting',
  },
  { probe: { method: 'POST', path: '/api/projects/:project/reveal' }, why: 'host file manager' },
  {
    probe: { method: 'POST', path: '/api/projects/:project/clear-errors' },
    why: 'failed-turn banner',
  },
  {
    probe: { method: 'POST', path: '/api/projects/:project/export-project-type' },
    why: 'project type export UI',
  },
  {
    probe: { method: 'POST', path: '/api/projects/:project/import-project-type' },
    why: 'project type import UI',
  },
  { probe: { method: 'POST', path: '/api/gezels/reset-templates' }, why: 'Settings' },
  { probe: { method: 'DELETE', path: '/api/gezels/:other' }, why: 'roster UI' },
  {
    probe: { method: 'GET', path: '/api/tasks' },
    why: 'list_tasks without a project; a worker MCP child falls back to its own project route',
  },
];

const ALL_PROBES: ReadonlyArray<{ owner: string; probe: CoordinatorRouteProbe }> = [
  ...Object.entries(COORDINATOR_ONLY_TOOL_ROUTES).flatMap(([tool, probes]) =>
    probes.map((probe) => ({ owner: tool, probe })),
  ),
  ...UNTOOLED_COORDINATOR_ROUTES.map(({ probe, why }) => ({ owner: `(no tool: ${why})`, probe })),
];

function concretePath(probe: CoordinatorRouteProbe): string {
  return probe.path
    .replaceAll(':project', PROJECT)
    .replaceAll(':gezel', GEZEL)
    .replaceAll(':other', OTHER);
}

/** Both route guards, in server.ts order, over a session token. */
function guardedApp(
  team: boolean,
  onSessionDeny?: (reason: string) => void,
  opts: { teamGuard?: boolean } = {},
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      appId: `session:${SESSION}`,
      scopes: ['session'],
      projectId: PROJECT,
      gezelId: GEZEL,
      team,
    } as never);
    await next();
  });
  app.use(
    '/api/*',
    sessionRouteGuard({
      log: (line) => onSessionDeny?.(line.slice(line.lastIndexOf(': ') + 2)),
    }),
  );
  if (opts.teamGuard !== false) app.use('/api/*', teamRouteGuard({ mode: 'enforce' }));
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

async function replay(app: Hono, probe: CoordinatorRouteProbe): Promise<number> {
  const init: RequestInit = { method: probe.method };
  if (probe.method !== 'GET') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(
      probe.bindsOrigin ? { projectId: PROJECT, fromGezelId: GEZEL, fromSessionId: SESSION } : {},
    );
  }
  return (await app.request(concretePath(probe), init)).status;
}

const GUARD_SOURCE = readFileSync(new URL('../http/scope-guard.ts', import.meta.url), 'utf8');

function sliceBetween(start: string, end: string): string {
  const from = GUARD_SOURCE.indexOf(start);
  const to = GUARD_SOURCE.indexOf(end, from);
  if (from < 0 || to < 0) {
    const anchors = `${JSON.stringify(start)} … ${JSON.stringify(end)}`;
    throw new Error(`scope-guard.ts no longer contains ${anchors}; re-derive this scan`);
  }
  return GUARD_SOURCE.slice(from, to);
}

describe('coordinator-only tool table', () => {
  it('names only registered MCP tools', () => {
    const unknown = [...COORDINATOR_ONLY_TOOLS].filter(
      (name) => !Object.hasOwn(TOOL_REGISTRY, name),
    );
    expect(unknown).toEqual([]);
  });

  it('covers the whole role-delegation family', () => {
    for (const name of Object.keys(TOOL_REGISTRY)) {
      if (/^(?:delegate|consult)_/.test(name)) expect(COORDINATOR_ONLY_TOOLS.has(name)).toBe(true);
    }
  });

  it('every listed route is refused to a worker and admitted to a coordinator', async () => {
    const worker = guardedApp(false);
    const coordinator = guardedApp(true);
    for (const { owner, probe } of ALL_PROBES) {
      const label = `${owner}: ${probe.method} ${probe.path}`;
      expect(await replay(worker, probe), label).toBe(403);
      expect(await replay(coordinator, probe), label).toBe(200);
    }
  });

  it('the session guard alone refuses each listed route, so it agrees with the team guard', async () => {
    // GEZEL_TEAM_SCOPE can put teamRouteGuard in audit/off; a worker must
    // still be refused, and the session guard must never admit what the
    // team guard refuses (it once admitted same-project message/ask/ensure).
    const sessionOnly = guardedApp(false, undefined, { teamGuard: false });
    for (const { owner, probe } of ALL_PROBES) {
      expect(await replay(sessionOnly, probe), `${owner}: ${probe.method} ${probe.path}`).toBe(403);
    }
  });
});

describe('every coordinator-only branch of scope-guard.ts is accounted for', () => {
  it('each "requires a coordinator" refusal is produced by a listed route', async () => {
    const reasons = new Set(
      [...GUARD_SOURCE.matchAll(/sessionDeny\(\s*'([^']*coordinator[^']*)'\s*\)/g)].map(
        (m) => m[1]!,
      ),
    );
    expect(reasons.size).toBeGreaterThan(0);
    const produced = new Set<string>();
    const worker = guardedApp(false, (reason) => produced.add(reason));
    for (const { probe } of ALL_PROBES) await replay(worker, probe);
    expect([...reasons].filter((reason) => !produced.has(reason))).toEqual([]);
  });

  it('each team-route matcher is exercised by a listed route', () => {
    const block = sliceBetween('const TEAM_ROUTE_MATCHERS', '\n];');
    const matchers = [...block.matchAll(/methods:\s*\[([^\]]*)\],\s*re:\s*\/(.+?)\/\s*}/g)].map(
      (m) => ({
        methods: [...m[1]!.matchAll(/'([A-Z]+)'/g)].map((x) => x[1]!),
        re: new RegExp(m[2]!),
      }),
    );
    expect(matchers.length).toBeGreaterThan(0);
    const uncovered = matchers.filter(
      ({ methods, re }) =>
        !ALL_PROBES.some(
          ({ probe }) => methods.includes(probe.method) && re.test(concretePath(probe)),
        ),
    );
    expect(uncovered.map(({ methods, re }) => `${methods.join('|')} ${re.source}`)).toEqual([]);
  });

  it('each project-item coordinator segment is exercised by a listed route', () => {
    const block = sliceBetween(
      'Project metadata, roster/import',
      "sessionDeny('route requires a coordinator session')",
    );
    const segments = [...block.matchAll(/\(\?:((?:[a-z-]+\|)+[a-z-]+)\)/g)].flatMap((m) =>
      m[1]!.split('|'),
    );
    expect(segments.length).toBeGreaterThan(0);
    const prefix = `/api/projects/${PROJECT}/`;
    const reached = new Set(
      ALL_PROBES.map(({ probe }) => concretePath(probe))
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split('/')[0]),
    );
    expect(segments.filter((segment) => !reached.has(segment))).toEqual([]);
  });
});
