import {
  type GezelConfig,
  type ResolvedHarnessToolsConfig,
  type RetrievalSource,
  isHarnessBlocked,
  isHarnessHiddenCatalog,
  parseHarnessAppId,
  resolveHarnessToolsConfig,
} from '@bendyline/gezel';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Deny-by-default route allowlist for `harness` tokens: an outside AI app
 * (Claude Code, Codex, Cursor, Claude Desktop, VS Code) running Gezel's
 * tools through `gezel-mcp --harness`. See docs/harness-tools.md.
 *
 * Independent of `sessionRouteGuard` on purpose. A gezel session is a
 * Gezel-run model with a gezel identity and a task; a harness is someone
 * else's model with neither, and its surface is far smaller. Nothing here
 * relies on `projectScopeGuard`, because a harness bound to no project
 * carries no `projectId` for that guard to check.
 *
 * Mounted on `/api/*` and `/events/*`. The token is ephemeral, so this
 * guard, the sink rules (image engine, memory stamp) and the person's
 * Settings → Integrations choices are the whole boundary.
 */

export const HARNESS_OFF_HINT =
  "Gezel's tools are turned off for other apps. Turn them on in Gezel: Settings → Integrations.";
export const HARNESS_STOPPED_HINT =
  'Gezel was told to stop this app in this folder. Turn it back on in Gezel: Settings → Integrations.';

/** The project a harness bound to no project uses for its library-and-knowledge search. */
export const HARNESS_UNBOUND_SEARCH_PROJECT = 'default';

const MEMORY_SOURCES: readonly RetrievalSource[] = ['project-memory', 'user-memory'];

/** Search corpora a harness may name. Never a gezel's private memory. */
export function harnessSearchSources(
  config: ResolvedHarnessToolsConfig,
  bound: boolean,
): readonly RetrievalSource[] {
  const memory = config.memory === 'off' ? [] : bound ? MEMORY_SOURCES : ['user-memory' as const];
  return bound
    ? ['workspace', 'artifacts', 'shared', 'knowledge', ...memory]
    : ['shared', 'knowledge', ...memory];
}

type Verdict = { allow: true } | { allow: false; reason: string };
const ALLOW: Verdict = { allow: true };
const deny = (reason: string): Verdict => ({ allow: false, reason });

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * How many issue verdicts one app may report per project in an hour: a
 * bound on a runaway loop, not the main safeguard (attribution, the verdict
 * log and Reopen are). 100 was too tight: a person running 20-issue batches
 * back to back hit it after five, about twenty minutes in (evaluation,
 * 2026-10-22).
 */
export const VERDICTS_PER_HOUR = 400;

/** A sliding hour of verdict counts per harness token (one app in one project). */
export class VerdictBudget {
  private readonly spent = new Map<string, number[]>();

  constructor(
    private readonly perHour = VERDICTS_PER_HOUR,
    private readonly now: () => number = Date.now,
  ) {}

  take(appId: string, count: number): boolean {
    const now = this.now();
    const recent = (this.spent.get(appId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length + count > this.perHour) {
      this.spent.set(appId, recent);
      return false;
    }
    for (let i = 0; i < count; i++) recent.push(now);
    this.spent.set(appId, recent);
    return true;
  }
}

export async function harnessRouteVerdict(
  c: Context,
  projectId: string | null,
  config: ResolvedHarnessToolsConfig,
  budget: VerdictBudget = new VerdictBudget(),
): Promise<Verdict> {
  const method = c.req.method;
  const path = c.req.path;
  if (path.startsWith('/events/') || path === '/events') {
    return deny('the event stream is not part of the harness API');
  }

  const project = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (project) {
    const id = decodeURIComponent(project[1] ?? '');
    const rest = project[2] ?? '';
    if (rest === '/tools/search' && method === 'POST') {
      const target = projectId ?? HARNESS_UNBOUND_SEARCH_PROJECT;
      if (id !== target) return deny(`search must target project ${target}`);
      const body = await readJson(c);
      if (!body) return deny('search needs a JSON body');
      if (body.gezelId !== undefined) return deny('a harness searches as no gezel');
      const allowed = harnessSearchSources(config, projectId !== null);
      const sources = body.sources;
      if (!Array.isArray(sources) || sources.length === 0) {
        return deny('a harness names the sources it searches');
      }
      const refused = sources.filter(
        (s) => typeof s !== 'string' || !allowed.includes(s as RetrievalSource),
      );
      return refused.length === 0
        ? ALLOW
        : deny(`search sources not open to this app: ${refused.join(', ')}`);
    }
    if (projectId === null || id !== projectId) {
      return deny('the route is outside the project this app is bound to');
    }
    if (rest === '' && method === 'GET') return ALLOW;
    if (rest === '/index/status' && method === 'GET') return ALLOW;
    if (rest === '/tools/read-doc-as-markdown' && method === 'POST') return ALLOW;
    if (rest === '/tools/issue-handoff' && method === 'POST') {
      return config.issues === 'off' ? deny('issues are off for other apps') : ALLOW;
    }
    if (rest === '/tools/issue-verdicts' && method === 'POST') {
      if (config.issues !== 'triage') return deny('reporting verdicts is off for other apps');
      const body = await readJson(c);
      if (!body || !Array.isArray(body.verdicts)) return deny('verdicts need a JSON body');
      if (body.by !== undefined) return deny('who decided comes from the app, never the body');
      // The token narrows what the app's model may do, and a model talked
      // into it by a file in the repo could otherwise dismiss everything.
      if (!budget.take(c.get('auth')?.appId ?? '', body.verdicts.length)) {
        return deny(
          `this app reported more than ${VERDICTS_PER_HOUR} verdicts in the last hour; wait and try again`,
        );
      }
      return ALLOW;
    }
    return deny('route is not part of the harness API');
  }

  if (path === '/api/recognition/describe' && method === 'POST') {
    const target = projectId ?? HARNESS_UNBOUND_SEARCH_PROJECT;
    if ((c.req.query('project') ?? 'default') !== target) {
      return deny(`image description must target project ${target}`);
    }
    if (projectId === null) {
      const body = await readJson(c);
      if (body?.artifactPath !== undefined) return deny('an unbound app sends image bytes');
    }
    return ALLOW;
  }

  if (path === '/api/image-gen/generate' && method === 'POST') {
    if (config.images === 'off') return deny('image generation is off for other apps');
    const body = await readJson(c);
    if (!body) return deny('image generation needs a JSON body');
    if (body.projectId !== (projectId ?? HARNESS_UNBOUND_SEARCH_PROJECT)) {
      return deny('image generation must target the bound project');
    }
    if (body.gezelId !== undefined || body.sessionId !== undefined) {
      return deny('a harness generates as no gezel');
    }
    if (body.saveAs !== undefined) return deny('a harness never writes into the folder');
    return ALLOW;
  }

  if (path === '/api/memory/save' && method === 'POST') {
    if (config.memory !== 'save') return deny('saving memories is off for other apps');
    if (projectId === null) return deny('an app bound to no project cannot save memories');
    const body = await readJson(c);
    return body?.scope === 'project' && body.id === projectId
      ? ALLOW
      : deny('a harness saves memories to its project only');
  }

  if (method === 'GET' && (path === '/api/documents' || path === '/api/documents/search')) {
    return ALLOW;
  }
  if (method === 'GET' && path === '/api/documents/read') {
    const docPath = (c.req.query('path') ?? '').replaceAll('\\', '/');
    if (docPath.startsWith('projects/') || c.req.query('project') !== undefined) {
      return deny('project documents are not part of the shared library');
    }
    return ALLOW;
  }

  if (method === 'GET' && path === '/api/knowledge/catalogs') return ALLOW;
  const catalogRead = /^\/api\/knowledge\/catalogs\/([^/]+)\/(?:document|passage)$/.exec(path);
  if (method === 'GET' && catalogRead) {
    return isHarnessHiddenCatalog(decodeURIComponent(catalogRead[1] ?? ''))
      ? deny('that knowledge catalog is not available to other apps')
      : ALLOW;
  }

  return deny('route is not part of the harness API');
}

export function harnessRouteGuard(opts: {
  readConfig: () => Promise<GezelConfig>;
  log?: (msg: string) => void;
  budget?: VerdictBudget;
}): MiddlewareHandler {
  const budget = opts.budget ?? new VerdictBudget();
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth?.scopes.includes('harness')) return next();
    const binding = parseHarnessAppId(auth.appId);
    if (!binding || (binding.projectId ?? undefined) !== auth.projectId) {
      return c.json({ error: 'forbidden', hint: 'malformed harness token' }, 403);
    }
    const config = resolveHarnessToolsConfig(await opts.readConfig());
    // A settings change revokes the tokens it affects; this catches a token
    // that raced that revocation.
    if (!config.enabled) {
      return c.json({ error: 'harness_tools_off', hint: HARNESS_OFF_HINT }, 403);
    }
    if (isHarnessBlocked(config, binding.client, binding.projectId)) {
      return c.json({ error: 'harness_disconnected', hint: HARNESS_STOPPED_HINT }, 403);
    }
    const verdict = await harnessRouteVerdict(c, binding.projectId, config, budget);
    if (verdict.allow) return next();
    opts.log?.(
      `[harness-scope] DENY ${auth.appId} ${c.req.method} ${c.req.path}: ${verdict.reason}`,
    );
    return c.json({ error: 'forbidden', code: 'harness_route', hint: verdict.reason }, 403);
  };
}
