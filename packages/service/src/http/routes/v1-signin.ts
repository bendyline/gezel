import {
  AccountSetupRequestSchema,
  SignInRequestSchema,
  type SignInResponse,
  type SignInState,
} from '@bendyline/gezel';
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { AccountError, type SessionMeta } from '../../accounts/manager.js';
import type { ServiceContext } from '../context.js';

/**
 * Account sign-in (ADR 0029). Mounted under `/v1/apps/signin` so it inherits
 * the no-CORS rule of `/v1/apps`: only a page served by this daemon can call
 * it from a browser. Nothing here needs a token except sign-out.
 */
export function v1SignInRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/state', (c) => {
    const accounts = ctx.accounts;
    const setupRequired = accounts ? !accounts.hasAccounts() : false;
    // Someone opening the setup screen after the code expired gets a fresh
    // one in the logs rather than a dead end.
    if (
      setupRequired &&
      ctx.accountsRequired &&
      accounts &&
      !accounts.setupCodeAvailable() &&
      process.env.GEZEL_SETUP_LINK !== '0'
    ) {
      ctx.announceSetupLink?.();
    }
    const state: SignInState = {
      accountsRequired: ctx.accountsRequired === true,
      setupRequired,
      setupCodeAvailable: accounts?.setupCodeAvailable() ?? false,
    };
    return c.json(state);
  });

  app.use('/setup', sameOriginJson);
  app.post('/setup', async (c) => {
    const accounts = ctx.accounts;
    if (!accounts) return c.json({ error: 'accounts_unavailable' }, 404);
    const body = AccountSetupRequestSchema.parse(await c.req.json());
    return respond(c, () => accounts.setup(body, sessionMeta(c)));
  });

  app.use('/', sameOriginJson);
  app.post('/', async (c) => {
    const accounts = ctx.accounts;
    if (!accounts) return c.json({ error: 'accounts_unavailable' }, 404);
    const body = SignInRequestSchema.parse(await c.req.json());
    return respond(c, () => accounts.signIn(body, sessionMeta(c)));
  });

  app.post('/signout', async (c) => {
    const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    if (!match?.[1] || !ctx.accounts) return c.json({ signedOut: false });
    return c.json({ signedOut: await ctx.accounts.signOut(match[1]) });
  });

  return app;
}

async function respond(c: Context, run: () => Promise<SignInResponse>) {
  try {
    const result = await run();
    c.header('cache-control', 'no-store');
    return c.json(result);
  } catch (err) {
    if (!(err instanceof AccountError)) throw err;
    if (err.code === 'throttled') {
      c.header('retry-after', String(err.retryAfterSeconds ?? 60));
      return c.json({ error: err.code, message: err.message }, 429);
    }
    const status = err.code === 'setup_closed' ? 409 : err.code === 'sign_in_failed' ? 401 : 400;
    return c.json({ error: err.code, message: err.message }, status);
  }
}

/**
 * A browser may call these only from this daemon's own pages: a cross-site
 * form or fetch could otherwise plant a session or probe passwords from a
 * page the person happens to have open. Non-browser clients send no
 * `Sec-Fetch-Site` and are judged by the JSON requirement alone.
 */
const sameOriginJson: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const site = c.req.header('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return c.json({ error: 'cross_site_refused' }, 403);
  }
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return c.json({ error: 'json_required' }, 415);
  }
  return next();
};

export function sessionMeta(c: Context): SessionMeta {
  let address: string | undefined;
  try {
    address = getConnInfo(c).remote.address;
  } catch {
    address = undefined;
  }
  // Behind the reverse proxy the container's LAN setup puts in front, every
  // caller is the proxy; trust its header only when the deployer says so, or
  // anyone could pick the address their failed sign-ins count against.
  if (process.env.GEZEL_TRUST_PROXY === '1') {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) address = forwarded;
  }
  const label = describeAgent(c.req.header('user-agent'));
  return {
    ...(address ? { address: address.replace(/^::ffff:/, '') } : {}),
    ...(label ? { label } : {}),
  };
}

/** "Firefox on Linux" from a user agent, for the list of signed-in browsers. */
export function describeAgent(agent: string | undefined): string | undefined {
  if (!agent) return undefined;
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : /^gezel-cli\//.test(agent)
            ? 'Gezel command line'
            : undefined;
  const os = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad/.test(agent)
      ? 'iOS'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : undefined;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? agent.slice(0, 60);
}
