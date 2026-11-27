import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LogLevel, getLogLevel, setLogLevel } from '@bendyline/gezel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inert, inertServiceContext } from '../test-support/inert-service-context.js';
import { isContainerDeniedPath } from './container-listener.js';
import type { ServiceContext } from './context.js';
import { buildApp } from './server.js';

/**
 * Every route the daemon registers, and who may reach it.
 *
 * The session guard is deny-by-default outside `/api/projects/:id/*` and
 * allow-by-default inside it, where most mutating handlers live. A new route
 * there was reachable by every gezel's session token with nothing forcing
 * anyone to decide whether it should be. This test makes the decision visible:
 * each registered route needs a row in `route-authority.json`, and a change in
 * who reaches a route changes that file in the same diff.
 *
 * Each row names who reaches the route: `owner` (the app's own credential),
 * `worker` and `coordinator` (a gezel's session token, without and with team
 * powers), `harness` (an outside AI app's token) and `container` (the
 * container listener's path denylist).
 *
 * Each request goes through the real `buildApp` chain (auth, the session and
 * harness guards, the project, team and identity scopes, and any route-local
 * check such as `requireFirstParty` or `isOwnerCaller` that runs before the
 * handler touches the service) with an inert context behind it. A 401 or 403
 * is a refusal; anything else means the request reached the handler. A check a
 * handler makes only after reading service state is not seen here.
 *
 * The probe uses an empty JSON body, the caller's own project and gezel, and a
 * turn the person did not start. Verdicts that depend on body fields (a
 * permission change in `PUT /api/projects/:id`, a schedule on a new task) are
 * pinned by `scope-guard.test.ts`, not here.
 *
 * After an intended change, regenerate the table and explain the new rows:
 *   UPDATE_ROUTE_AUTHORITY=1 vitest run src/http/route-authority.test.ts
 */

const TABLE_FILE = join(import.meta.dirname, 'route-authority.json');
const OWN_PROJECT = 'p1';
const OWN_GEZEL = 'gz-1';

type Caller = 'owner' | 'worker' | 'coordinator' | 'harness';
const CALLERS: readonly Caller[] = ['owner', 'worker', 'coordinator', 'harness'];
type Verdict = 'allow' | 'deny';
type Row = Record<Caller | 'container', Verdict>;

const TOKENS: Record<Caller, Record<string, unknown>> = {
  owner: { appId: 'root', appName: 'root', scopes: ['root'], kind: 'root' },
  worker: {
    appId: 'session:s-worker',
    appName: 'worker',
    scopes: ['session'],
    projectId: OWN_PROJECT,
    gezelId: OWN_GEZEL,
    team: false,
    kind: 'session',
  },
  coordinator: {
    appId: 'session:s-lead',
    appName: 'lead',
    scopes: ['session'],
    projectId: OWN_PROJECT,
    gezelId: OWN_GEZEL,
    team: true,
    kind: 'session',
  },
  harness: {
    appId: `harness:claude-code:${OWN_PROJECT}`,
    appName: 'Claude Code',
    scopes: ['harness'],
    projectId: OWN_PROJECT,
    kind: 'harness',
  },
};

function inertContext(home: string): ServiceContext {
  return inertServiceContext(home, {
    tokenStore: inert({
      lookup: (token: string) => TOKENS[token as Caller] ?? null,
      touch: () => undefined,
    }),
    chat: inert({
      isUserDirectedTurn: () => false,
      isCheckInTurn: () => false,
      getSessionRecord: async () => null,
    }),
    store: inert({
      readTask: async () => ({ status: 'active' }),
      projectLinksTo: async () => false,
      readConfig: async () => ({}),
    }),
  });
}

/** A concrete path for a registered pattern, using the caller's own ids. */
function concretePath(pattern: string): string {
  let firstParam = true;
  return pattern
    .replace(/:([A-Za-z_]+)(\{[^}]*\})?\??/g, (_whole, name: string, constraint?: string) => {
      const before = firstParam;
      firstParam = false;
      const candidates =
        name === 'num'
          ? ['1']
          : name === 'gezelId' || (before && pattern.startsWith('/api/gezels/'))
            ? [OWN_GEZEL]
            : name === 'projectId' || (before && pattern.startsWith('/api/projects/'))
              ? [OWN_PROJECT]
              : ['x1'];
      if (!constraint) return candidates[0]!;
      const re = new RegExp(`^${constraint.slice(1, -1)}$`);
      return [...candidates, '1', 'a', 'x1'].find((c) => re.test(c)) ?? candidates[0]!;
    })
    .replace(/\*/g, 'x');
}

async function verdictFor(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  caller: Caller,
): Promise<Verdict> {
  const probe = method === 'ALL' ? 'GET' : method;
  const request = app.request(`http://127.0.0.1:6228${path}`, {
    method: probe,
    headers: {
      authorization: `Bearer ${caller}`,
      ...(probe === 'GET' || probe === 'DELETE' ? {} : { 'content-type': 'application/json' }),
    },
    ...(probe === 'GET' || probe === 'DELETE' ? {} : { body: '{}' }),
  });
  const status = await Promise.race([
    Promise.resolve(request).then((res) => res.status),
    // A handler that waits on something the inert context never delivers
    // has already passed every check in front of it.
    new Promise<number>((resolve) => setTimeout(() => resolve(200), 3000)),
  ]);
  return status === 401 || status === 403 ? 'deny' : 'allow';
}

const COLUMNS = [...CALLERS, 'container'] as const;

/** One line per route naming who reaches it, e.g. `"owner coordinator container"`. */
function reachedBy(row: Row): string {
  const who = COLUMNS.filter((column) => row[column] === 'allow');
  return who.length > 0 ? who.join(' ') : 'nobody';
}

function serializeTable(table: Record<string, Row>): string {
  const keys = Object.keys(table).sort();
  const lines = keys.map(
    (key) => `  ${JSON.stringify(key)}: ${JSON.stringify(reachedBy(table[key]!))}`,
  );
  return `{\n${lines.join(',\n')}\n}\n`;
}

describe('route authority table', () => {
  let home: string;
  let previousLevel: LogLevel;
  let actual: Record<string, Row>;

  beforeAll(async () => {
    previousLevel = getLogLevel();
    // Handlers fail against the inert context by design; their errors are noise here.
    setLogLevel('silent');
    home = mkdtempSync(join(tmpdir(), 'gezel-route-authority-'));
    const app = buildApp(inertContext(home));
    const patterns = new Map<string, { method: string; path: string }>();
    for (const route of app.routes) {
      if (!route.path.startsWith('/api/') && !route.path.startsWith('/events/')) continue;
      patterns.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
    }
    actual = {};
    for (const [key, { method, path }] of patterns) {
      const concrete = concretePath(path);
      const row = {} as Row;
      for (const caller of CALLERS) row[caller] = await verdictFor(app, method, concrete, caller);
      row.container = isContainerDeniedPath(concrete) ? 'deny' : 'allow';
      actual[key] = row;
    }
  }, 300_000);

  afterAll(() => {
    setLogLevel(previousLevel);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('matches the checked-in table', () => {
    if (process.env.UPDATE_ROUTE_AUTHORITY === '1') {
      writeFileSync(TABLE_FILE, serializeTable(actual));
      return;
    }
    const expected = JSON.parse(readFileSync(TABLE_FILE, 'utf8')) as Record<string, string>;
    const added = Object.keys(actual).filter((key) => !(key in expected));
    const removed = Object.keys(expected).filter((key) => !(key in actual));
    const changed = Object.keys(actual)
      .filter((key) => key in expected)
      .filter((key) => reachedBy(actual[key]!) !== expected[key])
      .map((key) => `${key}: was "${expected[key]}", now "${reachedBy(actual[key]!)}"`);
    expect(
      { added, removed, changed },
      'Route authority changed. Decide whether a gezel session, a coordinator session, an outside app (harness) and the container listener should reach each route listed here, then run UPDATE_ROUTE_AUTHORITY=1 vitest run src/http/route-authority.test.ts and say why in the change.',
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  it('refuses every route to a caller with no token', async () => {
    const app = buildApp(inertContext(home));
    const unauthenticated = await app.request('http://127.0.0.1:6228/api/projects/p1', {
      method: 'GET',
    });
    expect(unauthenticated.status).toBe(401);
  });

  it('gives the owner every route a gezel can reach', () => {
    const wider = Object.entries(actual)
      .filter(([, row]) => row.owner === 'deny')
      .filter(([, row]) => row.worker === 'allow' || row.coordinator === 'allow')
      .map(([key]) => key);
    expect(wider).toEqual([]);
  });
});
