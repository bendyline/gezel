import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { GEZEL_VERSION, createLogger } from '@bendyline/gezel';
import { Hono, type MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import { safeJoin } from '../fs/safe-paths.js';
import {
  bearerAuth,
  denyRemoteInferenceScope,
  requireInternalApiAccess,
  requireScope,
} from './auth.js';
import type { ServiceContext } from './context.js';
import { v1Cors } from './cors.js';
import { hostGuard } from './host-guard.js';
import { openAiErrorEnvelope } from './openai-compat/error-envelope.js';
import { requireOpenAiEndpointsEnabled } from './openai-endpoints-gate.js';
import { PreviewCapabilityStore } from './preview-capability.js';
import { aiRoutes } from './routes/ai.js';
import { askRoutes } from './routes/asks.js';
import { audioRoutes } from './routes/audio.js';
import { cacheRoutes } from './routes/cache.js';
import { catalogRoutes } from './routes/catalog.js';
import { channelRoutes } from './routes/channels.js';
import { chatEventsRoutes } from './routes/chat-events.js';
import { chatRoutes } from './routes/chats.js';
import { configRoutes } from './routes/config.js';
import { connectorRoutes } from './routes/connectors.js';
import { craftbookRoutes } from './routes/craftbooks.js';
import { credentialRoutes } from './routes/credentials.js';
import { documentMediaExportRoutes } from './routes/document-media-export.js';
import { documentRoutes } from './routes/documents.js';
import { ds4Routes } from './routes/ds4.js';
import { enginesRoutes } from './routes/engines.js';
import { evalRoutes } from './routes/eval.js';
import { folderRoutes } from './routes/folders.js';
import { gezelRoutes } from './routes/gezels.js';
import { gitRoutes } from './routes/git.js';
import { githubRoutes } from './routes/github.js';
import { growthRoutes } from './routes/growth.js';
import { handboekRoutes } from './routes/handboek.js';
import { historyRoutes } from './routes/history.js';
import { imageGenRoutes } from './routes/image-gen.js';
import { imagesRoutes } from './routes/images.js';
import { llamaCppRoutes } from './routes/llama-cpp.js';
import { mailRoutes } from './routes/mail.js';
import { mcpToolRoutes } from './routes/mcp-tools.js';
import { meesterStatusRoutes } from './routes/meester-status.js';
import { memoryRoutes } from './routes/memory.js';
import { mlxRoutes } from './routes/mlx.js';
import { modelBundleRoutes } from './routes/model-bundles.js';
import { modelFitnessRoutes } from './routes/model-fitness.js';
import { modelsRoutes } from './routes/models.js';
import { nightShiftRoutes } from './routes/night-shift.js';
import { ollamaCompatRoutes } from './routes/ollama-compat.js';
import { ollamaRoutes } from './routes/ollama.js';
import { pageCheckRoutes } from './routes/page-check.js';
import { pageInvokeRoutes } from './routes/page-invoke.js';
import { permissionRoutes } from './routes/permissions.js';
import { previewCapabilityRoutes } from './routes/preview-capabilities.js';
import { previewLogRoutes } from './routes/preview-log.js';
import { previewRoutes } from './routes/preview.js';
import { projectGezelRoutes } from './routes/project-gezels.js';
import { globalTaskRoutes, projectTaskRoutes } from './routes/project-tasks.js';
import { projectRoutes } from './routes/projects.js';
import { questionRoutes } from './routes/questions.js';
import { reportActionRoutes } from './routes/report-actions.js';
import { queueRoutes } from './routes/queues.js';
import { recognitionRoutes } from './routes/recognition.js';
import { remotesRoutes } from './routes/remotes.js';
import { renderRoutes } from './routes/render.js';
import { globalScriptRoutes } from './routes/scripts-global.js';
import { scriptRoutes } from './routes/scripts.js';
import { sdkTypesRoutes } from './routes/sdk-types.js';
import { searchRoutes } from './routes/search.js';
import { sessionRoutes } from './routes/sessions.js';
import { suggestedWorkRoutes } from './routes/suggested-work.js';
import { systemToolsetRoutes } from './routes/system-toolsets.js';
import { systemRoutes } from './routes/system.js';
import { terminalRoutes } from './routes/terminals.js';
import { timelineRoutes } from './routes/timeline.js';
import { toolRoutes } from './routes/tools.js';
import { toolsetConfigRoutes } from './routes/toolset-config.js';
import { usageRoutes } from './routes/usage.js';
import { v1AppsRoutes } from './routes/v1-apps.js';
import { v1ChatRoutes } from './routes/v1-chat.js';
import { v1EmbeddingsRoutes } from './routes/v1-embeddings.js';
import { v1GezelsRoutes } from './routes/v1-gezels.js';
import { v1IdentityRoutes } from './routes/v1-identity.js';
import { v1ModelsEnsureRoutes } from './routes/v1-models-ensure.js';
import { v1ModelsRoutes } from './routes/v1-models.js';
import { v1OpenApiRoutes } from './routes/v1-openapi.js';
import { v1RemoteRoutes } from './routes/v1-remote.js';
import { videoGenRoutes } from './routes/video-gen.js';
import {
  gezelScopeGuard,
  projectScopeGuard,
  resolveIdentityScopeMode,
  resolveTeamScopeMode,
  resolveTokenScopeMode,
  sessionRouteGuard,
  teamRouteGuard,
} from './scope-guard.js';
import { shouldServeUiShell, staticUiCacheControl } from './static-ui.js';

export interface UnexpectedHttpErrorEvent {
  kind: 'unhandled_exception' | 'unsanitized_response';
  requestId: string;
  method: string;
  path: string;
  status: number;
  detail: string;
}

export type UnexpectedHttpErrorHandler = (event: UnexpectedHttpErrorEvent) => void;

interface BuildAppOptions {
  onUnexpectedHttpError?: UnexpectedHttpErrorHandler;
  /**
   * Preview-capability store to share with a separate plain-HTTP preview
   * listener (see `buildPreviewApp`). Both the minting endpoint (here) and
   * the serving route (there) must read the same store. Defaults to a fresh
   * private store when the caller doesn't split the two apps.
   */
  previewCapabilities?: PreviewCapabilityStore;
  /**
   * Origin of the plain-HTTP preview listener, so the mint endpoint can hand
   * back an external-browser URL that dodges the loopback-TLS cert warning.
   * Read lazily — the preview listener binds after this app is built.
   */
  previewBrowserOrigin?: () => string | null;
}

function notifyUnexpectedHttpError(
  handler: UnexpectedHttpErrorHandler | undefined,
  event: UnexpectedHttpErrorEvent,
  log: { error: (message: string) => void },
): void {
  if (!handler) return;
  try {
    handler(event);
  } catch (err) {
    log.error(
      `[http] unexpected-error observer failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
}

export function opaqueServerErrors(
  log: { error: (message: string) => void },
  onUnexpectedHttpError?: UnexpectedHttpErrorHandler,
): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status < 500) return;

    const prior = c.res;
    const raw = await prior
      .clone()
      .text()
      .catch(() => '');
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; requestId?: unknown };
      if (parsed.error === 'internal_error' && typeof parsed.requestId === 'string') return;
    } catch {
      /* sanitize non-JSON and malformed JSON errors too */
    }

    const requestId = randomUUID();
    const detail = raw.slice(0, 2000);
    log.error(
      `[http] route returned unsanitized ${prior.status} id=${requestId} method=${c.req.method} path=${c.req.path}: ${detail}`,
    );
    notifyUnexpectedHttpError(
      onUnexpectedHttpError,
      {
        kind: 'unsanitized_response',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: prior.status,
        detail,
      },
      log,
    );
    const replacement = new Response(JSON.stringify({ error: 'internal_error', requestId }), {
      status: prior.status,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    });
    for (const [name, value] of prior.headers) {
      if (name.startsWith('access-control-') || name === 'vary' || name === 'retry-after') {
        replacement.headers.set(name, value);
      }
    }
    replacement.headers.set('x-request-id', requestId);
    c.res = replacement;
  };
}

export function buildApp(ctx: ServiceContext, options: BuildAppOptions = {}): Hono {
  const app = new Hono();
  const previewCapabilities = options.previewCapabilities ?? new PreviewCapabilityStore();
  const httpLog = createLogger('http');

  app.use('*', async (c, next) => {
    await next();
    if (!c.req.path.startsWith('/preview/')) {
      c.res.headers.set(
        'content-security-policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data:",
          "media-src 'self' blob: data:",
          "worker-src 'self' blob:",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "frame-src 'self'",
          "frame-ancestors 'none'",
          "form-action 'self'",
        ].join('; '),
      );
      c.res.headers.set('x-frame-options', 'DENY');
    }
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'no-referrer');
  });

  // Strip HTTP/2-illegal hop-by-hop headers from every response BEFORE
  // it's serialized. `hono/streaming`'s `streamSSE` unconditionally sets
  // `Connection: keep-alive`, which Node's http2 layer rejects with
  // ERR_HTTP2_INVALID_CONNECTION_HEADERS — that's the gotcha we hit
  // when the daemon serves SSE over h2. Cheaper than forking Hono. The
  // strip is harmless under HTTP/1.1 (Node manages the connection on
  // its own when no header is sent), so we do it unconditionally rather
  // than gating on the negotiated protocol.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.delete('connection');
    c.res.headers.delete('keep-alive');
    c.res.headers.delete('upgrade');
    c.res.headers.delete('proxy-connection');
    c.res.headers.delete('transfer-encoding');
  });

  // Route-local catch blocks historically reflected exception messages in
  // JSON 500s, bypassing app.onError. Normalize every server error at the
  // outer boundary while retaining the full detail in correlated logs. This
  // belongs inside the security-header middleware so replacement responses
  // receive the same browser protections as successful responses.
  app.use('*', opaqueServerErrors(httpLog, options.onUnexpectedHttpError));

  // DNS-rebinding guard. Runs before auth and the static UI so a page on
  // an attacker-controlled hostname rebound to 127.0.0.1 can't reach any
  // surface. Loopback Host literals only; see host-guard.ts for why this
  // doesn't break legitimate cross-origin /v1 apps.
  app.use('*', hostGuard());

  // Gate only the API and event stream. The static UI bundle is public —
  // it's just HTML/JS/CSS, and the token needs to be injected by the UI
  // script anyway to hit the API. Loopback + bearer is still the real fence.
  // `/api/*` is the internal product API, gated by the per-launch root token,
  // scoped UI/session credentials, or an explicitly user-approved CLI token.
  // `/v1/*` is the public OpenAI-compatible facade aimed at third-party
  // local apps. Auth is selective: `/v1/apps/register` and the grant
  // polling endpoints must be reachable WITHOUT a token (the app
  // doesn't have one yet), so `/v1/apps` declares auth per-route inside
  // its router rather than at the mount.
  app.use('/api/*', bearerAuth(ctx.tokenStore));
  app.use('/api/*', requireInternalApiAccess());
  // A paired-device (`remote-inference`) token can ONLY run inference — confine
  // it to `/v1/remote/*` so it never reaches this host's projects/fs/sessions.
  app.use('/api/*', denyRemoteInferenceScope());
  app.use(
    '/events/*',
    bearerAuth(ctx.tokenStore, {
      allowQueryToken: (method, path) =>
        method === 'GET' &&
        ['/events/chat', '/events/chat/project', '/events/chat/all'].includes(path),
    }),
  );
  app.use('/events/*', requireInternalApiAccess());
  app.use('/events/*', denyRemoteInferenceScope());
  // A session's MCP bearer is not a renderer/admin credential. Admit only the
  // own-project/own-gezel and explicitly shared MCP routes classified by the
  // deny-by-default guard. Root/UI callers bypass it.
  const sessionRouteLog = createLogger('session-route');
  const scopedSessionRoutes = sessionRouteGuard({ log: (m) => sessionRouteLog.warn(m) });
  app.use('/api/*', scopedSessionRoutes);
  app.use('/events/*', scopedSessionRoutes);
  // Per-session token scope (#10): confine a session-scoped MCP token to
  // `/api/projects/<its project>/*`. Runs after bearerAuth (which populates
  // `c.var.auth`) and before the project routers below. Mode is set by
  // GEZEL_TOKEN_SCOPE (enforce [default] | audit | off); denials are logged.
  const scopeLog = createLogger('token-scope');
  app.use(
    '/api/projects/*',
    projectScopeGuard({
      mode: resolveTokenScopeMode(process.env.GEZEL_TOKEN_SCOPE),
      log: (m) => scopeLog.warn(m),
    }),
  );
  // Team-route gating (#10 increment 2): deny a NON-coordinator session
  // token the team/orchestration routes (create/message gezels, create
  // projects + tasks, cross-gezel asks). Runs across all of `/api/*` (team
  // routes span /api/gezels, /api/asks, /api/tasks, …). Enforced by default
  // (GEZEL_TEAM_SCOPE), with an explicit audit escape hatch for rollout
  // diagnostics.
  const teamLog = createLogger('team-scope');
  app.use(
    '/api/*',
    teamRouteGuard({
      mode: resolveTeamScopeMode(process.env.GEZEL_TEAM_SCOPE),
      log: (m) => teamLog.warn(m),
    }),
  );
  // Gezel-identity gating (#10 increment 3): confine a non-coordinator
  // session to its OWN gezel's identity/private state (path/query/body
  // gezelId). Coordinators bypass. Enforced by default
  // (GEZEL_IDENTITY_SCOPE), with an explicit audit escape hatch.
  const identityLog = createLogger('gezel-scope');
  app.use(
    '/api/*',
    gezelScopeGuard({
      mode: resolveIdentityScopeMode(process.env.GEZEL_IDENTITY_SCOPE),
      log: (m) => identityLog.warn(m),
    }),
  );
  // CORS for the public `/v1/*` surface so browser-resident apps (and
  // any localhost dev server) can hit the daemon. The middleware
  // attaches headers AFTER auth has run, so a 401 / 403 still carries
  // the CORS headers required for the browser to read the error.
  app.use('/v1/*', v1Cors());

  // Global error handler. Without this, a ZodError thrown from a route's
  // inline `Schema.parse(await c.req.json())` becomes a generic Hono 500
  // with no body content the client can use, and `GezelApiError` ends
  // up wrapping it as "Gezel API error 500 on POST …" — the model sees
  // no actionable message. The MCP-bridge layer surfaces the wrapped
  // message verbatim to the model, so a Zod schema mismatch (missing
  // `craftbookId`/`steps` on `create_task`, etc.) currently looks like
  // "API down" rather than "you need to supply this field".
  //
  // Translate ZodError → 422 + a flat one-line message that names the
  // path and the issue, e.g. `craftbookId: exactly one of craftbookId or
  // steps must be provided for the main craftbook`. Multiple issues join
  // with a semicolon so the model sees every constraint at once. Unexpected
  // exceptions are logged with a correlation id; their internal details are
  // never reflected to HTTP clients.
  app.onError((err, c) => {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((iss) => {
          const path = iss.path.length > 0 ? iss.path.join('.') : '(body)';
          return `${path}: ${iss.message}`;
        })
        .join('; ');
      return c.json({ error: issues }, 422);
    }
    const requestId = randomUUID();
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    httpLog.error(
      `[http] unhandled request error id=${requestId} method=${c.req.method} path=${c.req.path}: ${detail}`,
    );
    notifyUnexpectedHttpError(
      options.onUnexpectedHttpError,
      {
        kind: 'unhandled_exception',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: 500,
        detail,
      },
      httpLog,
    );
    return c.json({ error: 'internal_error', requestId }, 500);
  });

  app.get('/api/health', (c) => {
    // The supervisor sets three env vars about the llama-server backend:
    //   GEZEL_LLAMA_SERVER_BACKEND   — what's actually configured this
    //                                  launch (override-applied; may be
    //                                  undefined if no binary matched).
    //   GEZEL_LLAMA_DETECTED_BACKEND — what the hardware probe found,
    //                                  independent of any override.
    //   GEZEL_LLAMA_DETECTED_VENDOR  — best-effort GPU vendor (amd /
    //                                  nvidia / intel), independent of
    //                                  the chosen backend. Lets the
    //                                  Home tab label "AMD GPU" instead
    //                                  of generic "GPU" for Radeon
    //                                  users on the Vulkan backend.
    // Forward all three so the Home tab can label what's running AND
    // the Settings dropdown can offer the full set of hardware-supported
    // choices regardless of any user pin.
    const known = ['cuda', 'vulkan', 'metal', 'cpu'] as const;
    const knownVendors = ['amd', 'nvidia', 'intel'] as const;
    const backendRaw = process.env.GEZEL_LLAMA_SERVER_BACKEND;
    const detectedRaw = process.env.GEZEL_LLAMA_DETECTED_BACKEND;
    const vendorRaw = process.env.GEZEL_LLAMA_DETECTED_VENDOR;
    const llamaCppBackend = known.find((b) => b === backendRaw);
    const llamaCppDetectedBackend = known.find((b) => b === detectedRaw);
    const llamaCppDetectedVendor = knownVendors.find((v) => v === vendorRaw);
    return c.json({
      ok: true as const,
      version: GEZEL_VERSION,
      startedAt: ctx.startedAt,
      nodeVersion: process.versions.node,
      platform: process.platform,
      ...(llamaCppBackend ? { llamaCppBackend } : {}),
      ...(llamaCppDetectedBackend ? { llamaCppDetectedBackend } : {}),
      ...(llamaCppDetectedVendor ? { llamaCppDetectedVendor } : {}),
    });
  });

  app.route('/api/gezels', gezelRoutes(ctx));
  // Chat sub-routes (history/send/reset) are mounted under /api/agents too
  // so they hang off the agent they belong to.
  app.route('/api/gezels', chatRoutes(ctx));
  // Growth (XP / level-ups / traits) at /api/gezels/:id/growth/*
  app.route('/api/gezels', growthRoutes(ctx));
  app.route('/api/config', configRoutes(ctx));
  app.route('/api/credentials', credentialRoutes(ctx));
  app.route('/api/memory', memoryRoutes(ctx));
  app.route(
    '/api/projects',
    previewCapabilityRoutes(ctx, previewCapabilities, options.previewBrowserOrigin ?? (() => null)),
  );
  app.route('/api/projects', pageCheckRoutes(ctx, previewCapabilities));
  app.route('/api/projects', previewLogRoutes(ctx));
  // Interactive type pages: the first-party bridge relaying page tool
  // invokes at /api/projects/:id/page-invoke (see routes/page-invoke.ts).
  app.route('/api/projects', pageInvokeRoutes(ctx));
  app.route('/api/projects', projectRoutes(ctx));
  // Per-project gezels + import review queue at /api/projects/:id/gezels|imports/*
  app.route('/api/projects', projectGezelRoutes(ctx));
  // Suggested night work toggles at /api/projects/:id/suggested-work/*
  app.route('/api/projects', suggestedWorkRoutes(ctx));
  // Report-embedded action requests at /api/projects/:id/report-actions/*
  app.route('/api/projects', reportActionRoutes(ctx));
  // Per-project GitHub operations live at /api/projects/:id/github/*
  app.route('/api/projects', gitRoutes(ctx, 'git'));
  // Legacy alias: the same local-git routes under the old /github segment,
  // kept so older HTTP clients (e.g. a stale VSCode extension talking to a
  // newer machine daemon) keep working. Removal is a deliberate breaking
  // release, not a cleanup.
  app.route('/api/projects', gitRoutes(ctx, 'github'));
  app.route('/api/projects', githubRoutes(ctx));
  // Per-project mail operations live at /api/projects/:id/mail/*
  app.route('/api/projects', mailRoutes(ctx));
  // Per-project connector operations live at /api/projects/:id/connectors/*
  app.route('/api/projects', connectorRoutes(ctx));
  // Per-project tasks live at /api/projects/:id/tasks/*
  app.route('/api/projects', projectTaskRoutes(ctx));
  app.route('/api/projects', scriptRoutes(ctx));
  app.route('/api/scripts', globalScriptRoutes(ctx));
  app.route('/api/sdk', sdkTypesRoutes());
  // Per-session pasted/uploaded images live at
  // /api/projects/:pid/sessions/:sid/images[/:filename]
  app.route('/api/projects', imagesRoutes(ctx));
  // Per-project tool endpoints backing new MCP tools (fetch_url,
  // search_files, find_files, diff_files, read_image_as_base64,
  // list/extract_archive, run_git). Live at /api/projects/:id/tools/*.
  app.route('/api/projects', toolRoutes(ctx));
  // Per-project terminal threads live at /api/projects/:id/terminals/*
  app.route('/api/projects', terminalRoutes(ctx));
  app.route('/api/tasks', globalTaskRoutes(ctx));
  app.route('/api/craftbooks', craftbookRoutes(ctx));
  app.route('/api/usage', usageRoutes(ctx));
  app.route('/api/queues', queueRoutes(ctx));
  app.route('/api/cache', cacheRoutes(ctx));
  app.route('/api/ai', aiRoutes(ctx));
  app.route('/api/documents', documentRoutes(ctx));
  app.route('/api/document-media-export', documentMediaExportRoutes(ctx));
  app.route('/api/search', searchRoutes(ctx));
  app.route('/api/folders', folderRoutes(ctx));
  app.route('/api/models', modelsRoutes(ctx));
  // Remote model execution: A's paired-server admin surface (list/pair/unpair).
  app.route('/api/remotes', remotesRoutes(ctx));
  app.route('/api/ollama', ollamaRoutes(ctx));
  app.route('/api/llama-cpp', llamaCppRoutes(ctx));
  app.route('/api/model-fitness', modelFitnessRoutes(ctx));
  app.route('/api/ds4', ds4Routes(ctx));
  app.route('/api/mlx', mlxRoutes(ctx));
  app.route('/api/model-bundles', modelBundleRoutes(ctx));
  app.route('/api/engines', enginesRoutes(ctx));
  app.route('/api/eval', evalRoutes(ctx));
  app.route('/api/image-gen', imageGenRoutes(ctx));
  app.route('/api/video-gen', videoGenRoutes(ctx));
  app.route('/api/audio', audioRoutes(ctx));
  app.route('/api/recognition', recognitionRoutes(ctx));
  app.route('/api/catalog', catalogRoutes(ctx));
  app.route('/api/toolset', toolsetConfigRoutes(ctx));
  app.route('/api/sessions', sessionRoutes(ctx));
  // Direct MCP tool list/invoke for CLI/TUI "CLI mode" — also under
  // /api/sessions/:id/tools/*.
  app.route('/api/sessions', mcpToolRoutes(ctx));
  app.route('/api/questions', questionRoutes(ctx));
  app.route('/api/permissions', permissionRoutes(ctx));
  app.route('/api/asks', askRoutes(ctx));
  app.route('/api/system', systemRoutes(ctx));
  app.route('/api/night-shift', nightShiftRoutes(ctx));
  app.route('/api/meester-status', meesterStatusRoutes(ctx));
  app.route('/api/system-toolsets', systemToolsetRoutes(ctx));
  app.route('/api/history', historyRoutes(ctx));
  app.route('/api/handboek', handboekRoutes(ctx));
  app.route('/api/channels', channelRoutes(ctx));
  app.route('/api/render', renderRoutes(ctx));
  app.route('/api/timeline', timelineRoutes(ctx));
  app.route('/events/chat', chatEventsRoutes(ctx));

  // Master switch for the OpenAI-compatible facade (Settings →
  // Connected Apps). Gates inference surfaces AND new app registrations
  // below; the rest of `/v1/apps/*` (list/approve/revoke) stays
  // reachable so the panel works while the facade is off.
  const openaiEndpointsGate = requireOpenAiEndpointsEnabled(ctx);
  app.use('/v1/apps/register', openaiEndpointsGate);

  // `/v1/apps/*` is the public registration + consent surface. Routes
  // inside declare their own auth (some unauth, some root-only, some
  // per-app); see `routes/v1-apps.ts` for the per-endpoint matrix.
  app.route('/v1/apps', v1AppsRoutes(ctx));

  // `/v1/openapi.json` describes the public contract — served unauth
  // so app authors browsing the schema don't need a token first.
  app.route('/v1/openapi.json', v1OpenApiRoutes(ctx));

  // `/v1/identity` — unauth device-identity handshake for remote model
  // execution pairing (public material only; no token exists yet at pairing).
  app.route('/v1/identity', v1IdentityRoutes(ctx));

  // `/ollama/v1/*` — Ollama-compatible facade (tags + chat). Auth +
  // openai scope match `/v1/*`. CORS is also enabled so browser apps
  // targeting Ollama can swap baseUrl without origin grief.
  app.use('/ollama/v1/*', v1Cors());
  app.use('/ollama/v1/*', openaiEndpointsGate);
  app.use('/ollama/v1/*', bearerAuth(ctx.tokenStore));
  app.use('/ollama/v1/*', requireScope('openai'));
  app.route('/ollama/v1', ollamaCompatRoutes(ctx));

  // `/v1/chat/*` and `/v1/models/*` are the OpenAI-compatible inference
  // surface. Gated by bearer auth + the `openai` scope (root passes
  // any scope check). Third-party apps acquire a token through
  // `/v1/apps/register`; the desktop/CLI discovery credential explicitly
  // carries `openai`. Session/MCP tokens do not reach this facade, while the
  // process-local root remains the deliberate wildcard.
  app.use('/v1/chat/*', openAiErrorEnvelope());
  app.use('/v1/chat/*', openaiEndpointsGate);
  app.use('/v1/chat/*', bearerAuth(ctx.tokenStore));
  app.use('/v1/chat/*', requireScope('openai'));
  app.route('/v1/chat', v1ChatRoutes(ctx));

  // `/v1/remote/*` — inference-only surface for paired client devices. Gated by
  // the `remote-inference` scope, so a remote token reaches ONLY inference and
  // gets 403 on every project/fs `/api/*` route.
  app.use('/v1/remote/*', bearerAuth(ctx.tokenStore));
  app.use('/v1/remote/*', requireScope('remote-inference'));
  app.route('/v1/remote', v1RemoteRoutes(ctx));

  app.use('/v1/embeddings', openAiErrorEnvelope());
  app.use('/v1/embeddings', openaiEndpointsGate);
  app.use('/v1/embeddings', bearerAuth(ctx.tokenStore));
  app.use('/v1/embeddings', requireScope('openai'));
  app.use('/v1/embeddings/*', openAiErrorEnvelope());
  app.use('/v1/embeddings/*', openaiEndpointsGate);
  app.use('/v1/embeddings/*', bearerAuth(ctx.tokenStore));
  app.use('/v1/embeddings/*', requireScope('openai'));
  app.route('/v1/embeddings', v1EmbeddingsRoutes(ctx));

  app.use('/v1/gezels', openAiErrorEnvelope());
  app.use('/v1/gezels', openaiEndpointsGate);
  app.use('/v1/gezels', bearerAuth(ctx.tokenStore));
  app.use('/v1/gezels', requireScope('openai'));
  app.use('/v1/gezels/*', openAiErrorEnvelope());
  app.use('/v1/gezels/*', openaiEndpointsGate);
  app.use('/v1/gezels/*', bearerAuth(ctx.tokenStore));
  app.use('/v1/gezels/*', requireScope('openai'));
  app.route('/v1/gezels', v1GezelsRoutes(ctx));

  app.use('/v1/models', openAiErrorEnvelope());
  app.use('/v1/models', openaiEndpointsGate);
  app.use('/v1/models', bearerAuth(ctx.tokenStore));
  app.use('/v1/models', requireScope('openai'));
  app.use('/v1/models/*', openAiErrorEnvelope());
  app.use('/v1/models/*', openaiEndpointsGate);
  app.use('/v1/models/*', bearerAuth(ctx.tokenStore));
  app.use('/v1/models/*', requireScope('openai'));
  // `/v1/models/ensure*` MUST mount BEFORE the bare `/v1/models` route
  // so its more specific paths win — Hono's nested routers don't
  // intercept extensions otherwise.
  app.route('/v1/models/ensure', v1ModelsEnsureRoutes(ctx));
  app.route('/v1/models', v1ModelsRoutes(ctx));
  // Header-less iframe requests authenticate with a short-lived capability
  // minted by the first-party project endpoint. A path segment carries it so
  // relative assets inherit authority without exposing a UI/root credential.
  app.route('/preview', previewRoutes(ctx, previewCapabilities));

  // Static UI. If the service was built with a bundled @bendyline/gezel-ui bundle,
  // serve it at `/`. Otherwise return a friendly placeholder so browsers
  // hitting the daemon directly see something sensible.
  if (ctx.uiDir) {
    app.get('/*', async (c) => {
      const rel = c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\/+/, '');
      const file = safeJoin(ctx.uiDir!, rel);
      if (!file) return c.notFound();
      try {
        const s = await stat(file);
        if (!s.isFile()) {
          if (!shouldServeUiShell(rel)) return c.notFound();
          // Fall through to index.html for client-side routing.
          const html = await readFile(join(ctx.uiDir!, 'index.html'));
          return c.body(html, 200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': staticUiCacheControl('index.html'),
          });
        }
        const content = await readFile(file);
        return c.body(content, 200, {
          'content-type': contentType(extname(file)),
          'cache-control': staticUiCacheControl(rel),
        });
      } catch {
        if (!shouldServeUiShell(rel)) return c.notFound();
        try {
          const html = await readFile(join(ctx.uiDir!, 'index.html'));
          return c.body(html, 200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': staticUiCacheControl('index.html'),
          });
        } catch {
          return c.notFound();
        }
      }
    });
  } else {
    app.get('/', (c) =>
      c.html(
        `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>Gezel daemon</h1><p>Version ${GEZEL_VERSION}. The web UI bundle was not included with this build. Use the CLI or a client to interact.</p></body></html>`,
      ),
    );
  }

  return app;
}

/**
 * A minimal Hono app that serves ONLY the `/preview/*` route, meant to run on
 * a separate plain-HTTP loopback listener alongside the main HTTPS app.
 *
 * Why a second app and not just the main one over HTTP: the whole point of
 * loopback TLS is to keep the bearer-gated `/api` surface off a plain-HTTP
 * port. Preview is the one surface that doesn't rely on that transport — it's
 * authenticated by an in-path capability token and sandboxed with its own CSP
 * — so it's safe to expose over HTTP, letting an external browser open a
 * preview without the self-signed-cert warning. The capability store is shared
 * with the main app (which mints the tokens); this app only serves them.
 */
export function buildPreviewApp(
  ctx: ServiceContext,
  previewCapabilities: PreviewCapabilityStore,
  options: BuildAppOptions = {},
): Hono {
  const app = new Hono();
  const httpLog = createLogger('http-preview');

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.delete('connection');
    c.res.headers.delete('keep-alive');
    c.res.headers.delete('upgrade');
    c.res.headers.delete('proxy-connection');
    c.res.headers.delete('transfer-encoding');
  });
  app.use('*', opaqueServerErrors(httpLog, options.onUnexpectedHttpError));
  app.use('*', hostGuard());
  app.route('/preview', previewRoutes(ctx, previewCapabilities));
  app.get('/*', (c) => c.json({ error: 'not found' }, 404));

  return app;
}

function contentType(ext: string): string {
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
