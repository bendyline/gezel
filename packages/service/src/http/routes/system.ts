import { freemem, totalmem } from 'node:os';
import { delimiter, dirname } from 'node:path';
import {
  GEZEL_VERSION,
  type GitHubIdentity,
  type GitHubIdentityResponse,
  GitHubLoginPollRequestSchema,
  type GitHubLoginPollResponse,
  type GitHubLoginStartResponse,
  GitHubRepoPreviewRequestSchema,
  type GitHubRepoPreviewResponse,
  type GitHubRepoSummary,
  type GitHubReposResponse,
  MachineMemoryUsageSchema,
  ModelDownloadPreflightRequestSchema,
  ModelDownloadPreflightResponseSchema,
  PNPM_HOISTED_NODE_LINKER,
  SystemDiagnosticsSchema,
  type SystemHomeInfo,
  SystemHomeInfoSchema,
  createLogger,
} from '@bendyline/gezel';
import { Octokit } from '@octokit/rest';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  clearGitHubToken,
  fetchGitHubIdentity,
  getStoredGitHubToken,
  storeGitHubToken,
} from '../../github/identity.js';
import { pollDeviceFlow, startDeviceFlow } from '../../github/oauth.js';
import {
  GitHubAccessDeniedError,
  GitHubRepoNotFoundError,
  InvalidGitHubUrlError,
  previewGitHubRepo,
} from '../../github/repo-preview.js';
import { modelStorageRoots } from '../../models/storage-roots.js';
import { resolvePnpmCommand, spawnPnpm } from '../../packages/pnpm.js';
import { resolveCopilotAvailability } from '../../providers/copilot-availability.js';
import { resolveDefaultProviderName } from '../../providers/default-provider.js';
import { resolveInstalledSystemLibrary } from '../../system-toolsets/resolve.js';
import { sampleDarwinSystemMemoryCached } from '../../system/darwin-memory.js';
import { collectSystemDiagnosticsCached } from '../../system/diagnostics.js';
import { sampleDarwinGezelProcessMemoryCached } from '../../system/gezel-process-memory.js';
import {
  detectMemoryProfile,
  detectMemoryProfileCached,
  sampleMachineMemoryUsage,
  summarizeResidentModels,
} from '../../system/memory.js';
import { checkDiskSpace } from '../../utils/disk-space.js';
import type { ServiceContext } from '../context.js';
import { machineEngineProxy } from './machine-engine-proxy.js';

const log = createLogger('http');

export function systemRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.use(
    '/memory/usage',
    machineEngineProxy(ctx, '/api/system/memory', '/v1/remote/manage/system/memory'),
  );
  app.route('/memory', systemMemoryRoutes(ctx));

  /**
   * OS-idle heartbeat from the Electron shell (powerMonitor.getSystemIdleTime).
   * Gates the background "boekwachter" enrichment loop so heavy local-model work
   * only runs when the user is actually away. Headless runs never call this.
   */
  app.post('/idle', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { idleSeconds?: number };
    const idle = Number(body.idleSeconds);
    if (Number.isFinite(idle)) ctx.systemIdle.report(idle);
    return c.json({ ok: true });
  });

  /**
   * Memory the local machine can realistically dedicate to inference.
   * Drives UI filtering of Ollama model recommendations — users should
   * see "will this run?" guidance before they sink 20 minutes into a
   * pull that won't fit.
   */
  app.get('/memory', async (c) => {
    const profile = await detectMemoryProfile();
    return c.json(profile);
  });

  /**
   * Check one user-approved download plan against the filesystem that owns
   * Gezel's writable media-model store. All media engines resolve beneath the
   * same writable model-store parent in supported layouts, so checking the
   * combined byte total here prevents several individually-valid downloads
   * from collectively filling that volume.
   */
  app.post('/model-download-preflight', async (c) => {
    const parsed = ModelDownloadPreflightRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: 'sizeBytes must be a positive integer no larger than 10 TiB' }, 400);
    }
    const writableRoot = modelStorageRoots({ home: ctx.home, engine: 'sd-cpp' }).writableRoot;
    const check = await checkDiskSpace(writableRoot, parsed.data.sizeBytes);
    return c.json(
      ModelDownloadPreflightResponseSchema.parse({
        ...check,
        storageLocation: 'Gezel model storage',
      }),
    );
  });

  /**
   * Shareable machine profile for the "Report error on GitHub" dialog.
   *
   * Parsing through `SystemDiagnosticsSchema` on the way out is the privacy
   * boundary, not a formality: anything the collector assembles that the
   * schema does not declare is stripped instead of shipped to a public
   * issue tracker.
   */
  app.get('/diagnostics', async (c) => {
    const diagnostics = await collectSystemDiagnosticsCached({
      home: ctx.home,
      store: ctx.store,
      chat: ctx.chat,
    });
    return c.json(SystemDiagnosticsSchema.parse(diagnostics));
  });

  /**
   * Identity card for this daemon: which home it serves, whether that home
   * has ever actually been used, and what is resident right now. The
   * Electron supervisor reads this before committing to a machine-service
   * adoption (a factory-fresh machine home must not shadow a per-user home
   * full of real work), and it is the only window into a machine daemon
   * whose config/state directories are ACL-private to the service identity.
   *
   * Deliberately NOT part of `/diagnostics` — that schema is the privacy
   * boundary for public bug reports and must never carry home paths.
   *
   * `everUsed` is structural: a persisted session or a project beyond the
   * auto-created `default` only ever comes from use. Gezel count says
   * nothing (boot auto-creates the whole system crew), and
   * `firstRunCompleted` cannot serve either — the bootstrap sets it on
   * every daemon boot, including headless machine services no human has
   * ever opened.
   */
  app.get('/home', async (c) => {
    const [config, gezels, projects, sessions] = await Promise.all([
      ctx.store.readConfig(),
      ctx.store.listGezels(),
      ctx.store.listProjects(),
      ctx.store.listSessions(),
    ]);
    const provider = resolveDefaultProviderName(config);
    const defaultModel =
      typeof config.defaultModel === 'object' && config.defaultModel !== null
        ? (config.defaultModel as Record<string, string | undefined>)[provider]
        : undefined;
    const engineSnapshot = ctx.chat.peekEngineStatus();
    return c.json(
      SystemHomeInfoSchema.parse({
        home: ctx.home,
        scope: process.env.GEZEL_SYSTEM_SCOPE === '1' ? 'machine' : 'user',
        version: GEZEL_VERSION,
        startedAt: ctx.startedAt,
        firstRunCompleted: config.firstRunCompleted === true,
        usage: {
          gezelCount: gezels.length,
          projectCount: projects.length,
          sessionCount: sessions.length,
          everUsed: sessions.length > 0 || projects.length > 1,
        },
        ...(provider ? { provider } : {}),
        ...(defaultModel ? { defaultModel } : {}),
        memory: { totalBytes: totalmem(), freeBytes: freemem() },
        engines: (engineSnapshot?.entries ?? []).map((entry) => ({
          key: entry.key,
          residentBytes: entry.residentBytes,
        })),
      } satisfies SystemHomeInfo),
    );
  });

  /**
   * Who is currently authenticated with GitHub Copilot. The SDK answers
   * this uniformly for both the CLI-based flow and a stored PAT, so the
   * Settings UI can show "signed in as …" without knowing which mode
   * landed the credential. Always returns 200 — auth failures surface
   * via `{ ok: false, error }` so the caller doesn't have to distinguish
   * HTTP errors from "not signed in".
   */
  /**
   * Whether GitHub Copilot can be used on this device, and via which rung of
   * the resolution ladder. The single source of truth for every "should we
   * offer Copilot?" gate in the UI.
   *
   * Deliberately its own endpoint rather than a field on `GET /api/config`:
   * the config GET and PUT response whitelists have diverged, and the UI
   * reassigns its `config` from PUT responses all over Settings. A field
   * that only the GET emits would vanish the moment the user toggled an
   * unrelated setting, making the Copilot option blink out mid-session.
   */
  app.get('/copilot-status', async (c) => {
    return c.json(await resolveCopilotAvailability(ctx.home));
  });

  app.get('/copilot-user', async (c) => {
    try {
      const status = await ctx.chat.getCopilotAuthStatus();
      return c.json({ ok: true as const, status });
    } catch (err) {
      return c.json({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Run `copilot login` in-app, streaming the CLI's stdout/stderr
   * (device code URL, polling updates, success message) back as SSE
   * events so the UI can render a terminal-like pane. Spawns the
   * already-unpacked `@github/copilot-sdk` under the bundled pnpm +
   * bundled Node that the supervisor laid down at `~/.gezel/bin/` —
   * no system Node install required.
   *
   * On a clean exit (code 0) the Copilot CLI has written its token to
   * `~/.copilot`; the UI re-queries `/copilot-user` to pick up the
   * new auth state.
   */
  app.post('/copilot-login', async (c) => {
    const installed = await resolveInstalledSystemLibrary(ctx.home, '@github/copilot-sdk');
    if (!installed) {
      // Nothing is going to install this in the background — the SDK is an
      // on-demand toolset, so the only path forward is the Settings card.
      return c.json(
        {
          error:
            "GitHub Copilot isn't installed on this device. Open Settings → GitHub Copilot and choose Install, then sign in.",
        },
        503,
      );
    }
    const installDir = installed.path;
    const pnpmPath = process.env.GEZEL_PNPM_PATH;
    if (!pnpmPath) {
      return c.json(
        {
          error:
            'No bundled pnpm available — this endpoint only works inside the packaged desktop app.',
        },
        503,
      );
    }

    return streamSSE(c, async (stream) => {
      // Prepend the bundled Node's dir to PATH so `pnpm exec copilot`
      // resolves `node` from the bundle instead of whatever is (or
      // isn't) on the user's system PATH.
      const nodeDir = process.env.GEZEL_NODE_PATH ? dirname(process.env.GEZEL_NODE_PATH) : null;
      const extendedPath = nodeDir
        ? `${nodeDir}${delimiter}${process.env.PATH ?? ''}`
        : (process.env.PATH ?? '');
      const pnpm = resolvePnpmCommand([PNPM_HOISTED_NODE_LINKER, 'exec', 'copilot', 'login']);
      const child = spawnPnpm(pnpm, {
        cwd: installDir,
        env: { ...process.env, PATH: extendedPath, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already exited */
        }
      });

      const emit = async (payload: unknown) => {
        try {
          await stream.writeSSE({ data: JSON.stringify(payload) });
        } catch {
          /* stream closed */
        }
      };

      const pipeLines = (source: NodeJS.ReadableStream, kind: 'stdout' | 'stderr') => {
        let buf = '';
        source.setEncoding('utf8');
        source.on('data', (chunk: string) => {
          buf += chunk;
          let idx = buf.indexOf('\n');
          while (idx >= 0) {
            void emit({ kind, line: buf.slice(0, idx) });
            buf = buf.slice(idx + 1);
            idx = buf.indexOf('\n');
          }
        });
        source.on('end', () => {
          if (buf.length > 0) void emit({ kind, line: buf });
        });
      };

      if (child.stdout) pipeLines(child.stdout, 'stdout');
      if (child.stderr) pipeLines(child.stderr, 'stderr');

      await new Promise<void>((resolve) => {
        child.on('error', (err) => {
          void emit({ kind: 'error', message: err.message });
          resolve();
        });
        child.on('exit', (code) => {
          if (!aborted) {
            void emit({ kind: 'exit', code: code ?? -1 });
          }
          resolve();
        });
      });
    });
  });

  // ── GitHub OAuth device flow ───────────────────────────────────────
  //
  // Three endpoints back the inline sign-in chip on the New Project
  // dialog (and the equivalent in Settings):
  //   POST /api/system/github-login/start  → returns a device code +
  //        verification URI; the UI shows the user_code and opens the
  //        URI in a browser.
  //   POST /api/system/github-login/poll   → called every `interval`s
  //        with the device code until the user completes the flow on
  //        github.com (or it expires). On success, persists the token
  //        + identity to the SecretStore + config.
  //   POST /api/system/github-logout       → clears stored credentials.
  //   GET  /api/system/github-identity     → renders the chip without
  //        going through the keyring on every navigation; cached
  //        in-memory for IDENTITY_CACHE_MS to keep the UI snappy.
  //
  // The token also feeds the existing GitManager (clones, pulls,
  // PR queries) — `storeGitHubToken` writes to both secret slots.

  let identityCache: { at: number; identity: GitHubIdentity | null } | null = null;
  const IDENTITY_CACHE_MS = 60_000;

  const invalidateIdentityCache = () => {
    identityCache = null;
  };

  // Separate cache for the repo list — the New Project dialog calls it
  // exactly once per open, but a user clicking through "create" multiple
  // times in a row shouldn't hammer GitHub. 5 min is long enough to be
  // useful, short enough that a brand-new repo shows up after a coffee.
  let reposCache: { at: number; token: string; repos: GitHubRepoSummary[] } | null = null;
  const REPOS_CACHE_MS = 5 * 60_000;

  app.post('/github-login/start', async (c) => {
    try {
      const start = await startDeviceFlow();
      const body: GitHubLoginStartResponse = {
        deviceCode: start.deviceCode,
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        interval: start.interval,
        expiresIn: start.expiresIn,
      };
      return c.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  app.post('/github-login/poll', async (c) => {
    const { deviceCode } = GitHubLoginPollRequestSchema.parse(await c.req.json());
    let result: Awaited<ReturnType<typeof pollDeviceFlow>>;
    try {
      result = await pollDeviceFlow(deviceCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const body: GitHubLoginPollResponse = { status: 'not_configured', error: message };
      return c.json(body);
    }
    if (result.status !== 'success') {
      const body: GitHubLoginPollResponse = result;
      return c.json(body);
    }
    let identity: GitHubIdentity;
    try {
      identity = await fetchGitHubIdentity(result.accessToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({
        status: 'denied',
        error: `Token acquired but identity fetch failed: ${message}`,
      } as GitHubLoginPollResponse);
    }
    await storeGitHubToken(ctx.secrets, result.accessToken);
    await ctx.store.writeConfig({
      githubAuth: {
        kind: 'oauth',
        login: identity.login,
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
        scopes: result.scopes,
        acquiredAt: new Date().toISOString(),
      },
    });
    invalidateIdentityCache();
    const body: GitHubLoginPollResponse = {
      status: 'success',
      identity,
      scopes: result.scopes,
    };
    return c.json(body);
  });

  app.post('/github-logout', async (c) => {
    await clearGitHubToken(ctx.secrets);
    await ctx.store.writeConfig({ githubAuth: null });
    invalidateIdentityCache();
    reposCache = null;
    return c.json({ ok: true });
  });

  /**
   * Fetch metadata + README for a public/private GitHub URL. Used by
   * the New Project dialog when the user pastes a URL — the response
   * feeds the project-about preview LLM call. Not project-scoped: the
   * URL hasn't been linked to anything yet.
   */
  app.post('/github-repo-preview', async (c) => {
    const { url } = GitHubRepoPreviewRequestSchema.parse(await c.req.json());
    const token = await getStoredGitHubToken(ctx.secrets);
    try {
      const preview: GitHubRepoPreviewResponse = await previewGitHubRepo(token, url);
      return c.json(preview);
    } catch (err) {
      if (err instanceof InvalidGitHubUrlError) {
        return c.json({ error: err.message, code: 'INVALID_URL' }, 400);
      }
      if (err instanceof GitHubRepoNotFoundError) {
        return c.json(
          {
            error: err.message,
            code: 'REPO_NOT_FOUND',
            owner: err.owner,
            repo: err.repo,
          },
          404,
        );
      }
      if (err instanceof GitHubAccessDeniedError) {
        return c.json(
          {
            error: err.message,
            code: 'ACCESS_DENIED',
            status: err.status,
            ...(err.fixUrl ? { fixUrl: err.fixUrl } : {}),
          },
          err.status,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[github-repo-preview] unhandled error: ${message}`);
      return c.json({ error: message }, 502);
    }
  });

  /**
   * Authenticated user's accessible repos, sorted by most-recently
   * pushed. Powers the New Project dialog's GitHub URL dropdown.
   * Returns an empty list when the user isn't signed in (rather than
   * 401) so the UI can render a graceful empty state without branching.
   * In-memory cached for 5 min keyed by token so the dialog opening
   * multiple times in a row only hits GitHub once.
   */
  app.get('/github-repos', async (c) => {
    const token = await getStoredGitHubToken(ctx.secrets);
    if (!token) {
      const body: GitHubReposResponse = { repos: [] };
      return c.json(body);
    }
    const now = Date.now();
    if (reposCache && reposCache.token === token && now - reposCache.at < REPOS_CACHE_MS) {
      const body: GitHubReposResponse = { repos: reposCache.repos };
      return c.json(body);
    }
    try {
      const octokit = new Octokit({ auth: token, userAgent: 'gezel/0.0.0' });
      const { data } = await octokit.repos.listForAuthenticatedUser({
        sort: 'pushed',
        per_page: 100,
        affiliation: 'owner,collaborator,organization_member',
      });
      const repos: GitHubRepoSummary[] = data.map((r) => ({
        fullName: r.full_name,
        url: r.html_url,
        ...(r.description ? { description: r.description } : {}),
        ...(typeof r.private === 'boolean' ? { private: r.private } : {}),
        ...(r.pushed_at ? { pushedAt: r.pushed_at } : {}),
      }));
      reposCache = { at: now, token, repos };
      const body: GitHubReposResponse = { repos };
      return c.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[github-repos] fetch failed: ${message}`);
      const body: GitHubReposResponse = { repos: [] };
      return c.json(body);
    }
  });

  app.get('/github-identity', async (c) => {
    const now = Date.now();
    if (identityCache && now - identityCache.at < IDENTITY_CACHE_MS) {
      const cached = identityCache.identity;
      const body: GitHubIdentityResponse = cached
        ? { signedIn: true, ...cached }
        : { signedIn: false };
      return c.json(body);
    }
    const token = await getStoredGitHubToken(ctx.secrets);
    if (!token) {
      identityCache = { at: now, identity: null };
      const body: GitHubIdentityResponse = { signedIn: false };
      return c.json(body);
    }
    try {
      const identity = await fetchGitHubIdentity(token);
      identityCache = { at: now, identity };
      const body: GitHubIdentityResponse = { signedIn: true, ...identity };
      return c.json(body);
    } catch (err) {
      // Token is set but the API call failed — likely revoked or
      // network. Render as signed-out so the user can re-auth; don't
      // throw the token away (might be a transient network issue).
      identityCache = { at: now, identity: null };
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ signedIn: false, error: message } as GitHubIdentityResponse & {
        error: string;
      });
    }
  });

  return app;
}

/**
 * The machine-owner view of memory used by local inference. Kept as its own
 * router so the machine-engine capability boundary can expose this one safe
 * telemetry endpoint without mounting the product-facing `/api/system`
 * surface.
 */
export function systemMemoryRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  /**
   * Live memory pool behind local inference. This endpoint is intentionally
   * cheap enough to poll while the engine dropdown is open: accelerator
   * capacity is cached, device telemetry is coalesced by DeviceHealthGate,
   * and main-memory use comes from node:os.
   */
  app.get('/usage', async (c) => {
    const [profile, config] = await Promise.all([
      detectMemoryProfileCached(),
      ctx.store.readConfig(),
    ]);
    const configuredBackend =
      config.llamaCppBackendOverride && config.llamaCppBackendOverride !== 'auto'
        ? config.llamaCppBackendOverride
        : (process.env.GEZEL_LLAMA_SERVER_BACKEND ?? process.env.GEZEL_LLAMA_DETECTED_BACKEND);
    const forceMainMemory = configuredBackend === 'cpu';
    const unifiedMemory =
      profile.source === 'darwin-unified' ||
      profile.source === 'gpu-integrated' ||
      profile.gpuMemoryKind === 'unified';
    // Main/UMA memory comes from host counters (`vm_stat` on macOS). Avoid
    // spawning any SMI adapter there or on CPU-only hosts, where it cannot
    // improve this sample.
    const sampleDarwinMemory = profile.platform === 'darwin' && (forceMainMemory || unifiedMemory);
    const [deviceHealth, gezelProcessMemory, darwinSystemMemory] = await Promise.all([
      forceMainMemory || profile.source === 'system-ram-fallback' || unifiedMemory
        ? undefined
        : ctx.gpuArbiter.getDeviceHealthStatus(1_000),
      sampleDarwinMemory ? sampleDarwinGezelProcessMemoryCached({ home: ctx.home }) : null,
      sampleDarwinMemory
        ? sampleDarwinSystemMemoryCached({ totalBytes: profile.totalRamBytes })
        : null,
    ]);
    const engineSnapshot = ctx.chat.peekEngineStatus();
    const engineModelWeightsBytes = (engineSnapshot?.entries ?? []).reduce(
      (sum, entry) =>
        sum + Math.min(entry.modelWeightsBytes ?? entry.residentBytes, entry.residentBytes),
      0,
    );
    const engineLifecycles = (engineSnapshot?.entries ?? []).flatMap((entry) =>
      entry.lifecycle
        ? [
            {
              provider: entry.provider,
              modelId: entry.modelId,
              replicaIdx: entry.replicaIdx,
              ...entry.lifecycle,
            },
          ]
        : [],
    );
    const snapshot = {
      ...sampleMachineMemoryUsage({
        profile,
        ...(deviceHealth ? { deviceHealth } : {}),
        engineCommittedBytes: engineSnapshot?.committedBytes ?? 0,
        engineBudgetBytes: engineSnapshot?.enforced ? engineSnapshot.budgetBytes : null,
        residentModels: summarizeResidentModels(engineSnapshot?.entries ?? []),
        engineLifecycles,
        engineModelWeightsBytes,
        gezelProcessMemory,
        darwinSystemMemory,
        forceMainMemory,
      }),
      enginePools: engineSnapshot?.pools ?? null,
      ...(engineSnapshot?.ramSpillover ? { engineRamSpillover: engineSnapshot.ramSpillover } : {}),
    };
    return c.json(MachineMemoryUsageSchema.parse(snapshot));
  });

  return app;
}
