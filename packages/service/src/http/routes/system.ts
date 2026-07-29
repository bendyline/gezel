import { spawn } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import {
  type GitHubIdentity,
  type GitHubIdentityResponse,
  GitHubLoginPollRequestSchema,
  type GitHubLoginPollResponse,
  type GitHubLoginStartResponse,
  GitHubRepoPreviewRequestSchema,
  type GitHubRepoPreviewResponse,
  type GitHubRepoSummary,
  type GitHubReposResponse,
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
import { pnpmSpawnTarget, resolvePnpmCommand } from '../../packages/pnpm.js';
import { resolveSystemLibraryPath } from '../../system-toolsets/resolve.js';
import { detectMemoryProfile } from '../../system/memory.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

export function systemRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

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
   * Who is currently authenticated with GitHub Copilot. The SDK answers
   * this uniformly for both the CLI-based flow and a stored PAT, so the
   * Settings UI can show "signed in as …" without knowing which mode
   * landed the credential. Always returns 200 — auth failures surface
   * via `{ ok: false, error }` so the caller doesn't have to distinguish
   * HTTP errors from "not signed in".
   */
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
    const installDir = await resolveSystemLibraryPath(ctx.home, '@github/copilot-sdk');
    if (!installDir) {
      return c.json(
        {
          error:
            "The Copilot CLI hasn't finished installing yet. Wait for the system toolsets bootstrap to complete and try again.",
        },
        503,
      );
    }
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
      const pnpm = resolvePnpmCommand(['exec', 'copilot', 'login']);
      const target = pnpmSpawnTarget(pnpm);
      const child = spawn(target.command, target.args, {
        cwd: installDir,
        env: { ...process.env, PATH: extendedPath, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: pnpm.shell,
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
