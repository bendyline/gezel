import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inertServiceContext } from '../test-support/inert-service-context.js';
import { buildApp } from './server.js';

/**
 * Every request the typed client makes names a route the daemon registers.
 *
 * `client-contract.test.ts` compares the client with literals in its own
 * package, so a route renamed or removed on the service side, or a verb
 * changed, broke every caller of that client method with nothing failing in
 * CI unless the method happened to sit on a tested path; of 856 client
 * methods, 567 are named in no vitest file. This reads every
 * `this.request('VERB', path)` and `fetchImpl(`${this.baseUrl}/api/…`)` in the
 * client source and matches it against `buildApp`'s routes.
 */

const CLIENT_SOURCE = join(import.meta.dirname, '..', '..', '..', 'client', 'src', 'client.ts');

/** Global middleware mounts: they match every path and serve none. */
const MIDDLEWARE_MOUNTS = new Set([
  'ALL /api/*',
  'ALL /events/*',
  'ALL /api/projects/*',
  'ALL /api/projects/:id',
  'ALL /api/projects/:id/*',
  'ALL /api/gezels/:id',
  'ALL /api/gezels/:id/*',
]);

/** Routers that forward everything to another process, so no local route exists. */
const PROXIED_PREFIXES: Record<string, string> = {
  '/api/machine-serving/': "answered by the machine engine's /v1/remote/manage/serving",
  '/api/machine-serving': "answered by the machine engine's /v1/remote/manage/serving",
};

/**
 * Client calls whose template fills a literal route segment from a union
 * type, which reading the source cannot see. Each names the routes it means.
 */
const LITERAL_SEGMENT_CALLS: Record<string, string> = {
  'DELETE /api/audio/:p/models/:p/pull':
    'kind is stt | tts: /stt/models/:id/pull, /tts/models/:id/pull',
};

interface ClientCall {
  method: string;
  path: string;
  line: number;
}

/**
 * Template expressions become `:p`; a trailing query string goes. A query
 * built with a nested template (`${qs ? `?${qs}` : ''}`) cuts the capture at
 * its inner backtick and leaves an unclosed `${`, which is always the query.
 */
function normalizeClientPath(raw: string): string {
  return raw
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/\$\{.*$/, '')
    .replace(/\?.*$/, '')
    .replace(/(:p)+/g, ':p')
    .replace(/([^/]):p$/, '$1')
    .replace(/\/+$/, '');
}

function clientCalls(source: string): ClientCall[] {
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  const calls: ClientCall[] = [];
  for (const m of source.matchAll(/this\.request\s*(?:<[^>]*>)?\(\s*'([A-Z]+)'\s*,\s*`([^`]*)`/g)) {
    calls.push({ method: m[1]!, path: normalizeClientPath(m[2]!), line: lineOf(m.index) });
  }
  for (const m of source.matchAll(/this\.request\s*(?:<[^>]*>)?\(\s*'([A-Z]+)'\s*,\s*'([^']*)'/g)) {
    calls.push({ method: m[1]!, path: normalizeClientPath(m[2]!), line: lineOf(m.index) });
  }
  for (const m of source.matchAll(/this\.fetchImpl\(\s*`\$\{this\.baseUrl\}(\/[^`]*)`\s*,?/g)) {
    const after = source.slice(m.index, m.index + 600);
    const method = /method:\s*'([A-Z]+)'/.exec(after)?.[1] ?? 'GET';
    calls.push({ method, path: normalizeClientPath(m[1]!), line: lineOf(m.index) });
  }
  return calls.filter((call) => call.path.startsWith('/api/') || call.path.startsWith('/events/'));
}

function routeMatches(pattern: string, path: string): boolean {
  const want = path.split('/');
  const have = pattern.split('/');
  for (let i = 0; i < have.length; i++) {
    const segment = have[i]!;
    if (segment === '*') return true;
    const got = want[i];
    if (got === undefined) return false;
    if (segment.startsWith(':')) continue;
    if (got === ':p' || got !== segment) return false;
  }
  return want.length === have.length;
}

describe('client requests against registered routes', () => {
  let home: string;
  let routes: Array<{ method: string; path: string }>;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gezel-client-routes-'));
    // The UI's single-page fallback (`GET /*`) answers every path; the API
    // and the event stream are what the client talks to.
    routes = buildApp(inertServiceContext(home))
      .routes.filter((route) => route.path.startsWith('/api/') || route.path.startsWith('/events/'))
      .filter((route) => !MIDDLEWARE_MOUNTS.has(`${route.method} ${route.path}`))
      .map((route) => ({ method: route.method, path: route.path }));
  });

  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('finds the requests it is meant to check', () => {
    expect(clientCalls(readFileSync(CLIENT_SOURCE, 'utf8')).length).toBeGreaterThan(600);
  });

  it('notices a client path no route serves', () => {
    const known = (method: string, path: string) =>
      routes.some((route) => route.method === method && routeMatches(route.path, path));
    expect(known('GET', '/api/projects/:p/tasks')).toBe(true);
    expect(known('GET', '/api/projects/:p/no-such-route')).toBe(false);
    expect(known('PUT', '/api/projects/:p/tasks')).toBe(false);
    // Every exception still names something real.
    for (const call of Object.keys(LITERAL_SEGMENT_CALLS)) {
      const [method, path] = call.split(' ') as [string, string];
      expect(clientCalls(readFileSync(CLIENT_SOURCE, 'utf8'))).toContainEqual(
        expect.objectContaining({ method, path }),
      );
    }
  });

  it('has a route for every request the client makes', () => {
    // Only routes with a method of their own count: an `ALL` registration is
    // either middleware (a first-party guard, the git gate) or a proxy.
    const unmatched = clientCalls(readFileSync(CLIENT_SOURCE, 'utf8'))
      .filter(
        (call) =>
          !Object.keys(PROXIED_PREFIXES).some(
            (prefix) => call.path === prefix || call.path.startsWith(prefix),
          ) && !(`${call.method} ${call.path}` in LITERAL_SEGMENT_CALLS),
      )
      .filter(
        (call) =>
          !routes.some(
            (route) => route.method === call.method && routeMatches(route.path, call.path),
          ),
      )
      .map((call) => `client.ts:${call.line} ${call.method} ${call.path}`);
    expect(unmatched).toEqual([]);
  });
});
