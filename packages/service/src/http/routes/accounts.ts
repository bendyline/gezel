import {
  type AccountListResponse,
  type AccountSessionListResponse,
  CreateAccountRequestSchema,
  SetAccountPasswordRequestSchema,
  UpdateAccountRequestSchema,
} from '@bendyline/gezel';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { AccountError, type AccountManager } from '../../accounts/manager.js';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

/**
 * Account management (ADR 0029). First-party callers only. The owner's own
 * credential (the desktop app, the same-machine CLI, `docker exec … gezel`)
 * always manages accounts; a signed-in account does when its role allows,
 * which today is every account.
 */
export function accountRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.use('*', requireFirstParty());
  app.use('*', async (c, next) => {
    if (!ctx.accounts) return c.json({ error: 'accounts_unavailable' }, 404);
    return next();
  });

  const accounts = () => ctx.accounts as AccountManager;
  const callerAccountId = (c: Context) => c.get('auth')?.account?.id;

  const requireAccountAdmin: MiddlewareHandler = async (c, next) => {
    const id = callerAccountId(c);
    if (id === undefined || accounts().canManageAccounts(id)) return next();
    return c.json({ error: 'forbidden', message: 'This account cannot manage accounts.' }, 403);
  };

  // ── the caller's own account ───────────────────────────────────────────

  app.get('/me', (c) => {
    const id = callerAccountId(c);
    const me = id ? accounts().get(id) : null;
    return me ? c.json({ account: me }) : c.json({ error: 'not_signed_in' }, 404);
  });

  app.post('/me/password', async (c) => {
    const id = callerAccountId(c);
    if (!id) return c.json({ error: 'not_signed_in' }, 404);
    const body = SetAccountPasswordRequestSchema.parse(await c.req.json());
    return answer(c, async () => ({
      account: await accounts().setPassword(id, body.password, {
        requireCurrent: true,
        ...(body.currentPassword !== undefined ? { currentPassword: body.currentPassword } : {}),
        ...(c.get('auth')?.accountSessionId
          ? { keepSessionId: c.get('auth')?.accountSessionId }
          : {}),
      }),
    }));
  });

  app.get('/me/sessions', (c) => {
    const id = callerAccountId(c);
    if (!id) return c.json({ error: 'not_signed_in' }, 404);
    const body: AccountSessionListResponse = {
      sessions: accounts().listSessions(id, c.get('auth')?.accountSessionId),
    };
    return c.json(body);
  });

  app.delete('/me/sessions/:sessionId', async (c) => {
    const id = callerAccountId(c);
    if (!id) return c.json({ error: 'not_signed_in' }, 404);
    const sessionId = c.req.param('sessionId');
    const own = accounts()
      .listSessions(id)
      .some((s) => s.id === sessionId);
    if (!own) return c.json({ error: 'not_found' }, 404);
    return c.json({ revoked: await accounts().revokeSession(sessionId) });
  });

  // ── everyone's accounts ────────────────────────────────────────────────

  app.get('/', requireAccountAdmin, (c) => {
    const id = callerAccountId(c);
    const me = id ? accounts().get(id) : null;
    const body: AccountListResponse = {
      accounts: accounts().list(),
      ...(me ? { me } : {}),
    };
    return c.json(body);
  });

  app.post('/', requireAccountAdmin, async (c) => {
    const body = CreateAccountRequestSchema.parse(await c.req.json());
    return answer(c, async () => ({ account: await accounts().create(body) }), 201);
  });

  app.patch('/:id', requireAccountAdmin, async (c) => {
    const body = UpdateAccountRequestSchema.parse(await c.req.json());
    return answer(c, async () => ({ account: await accounts().update(c.req.param('id'), body) }));
  });

  /**
   * Set someone's password. Changing your own from a browser still asks for
   * the current one, so a borrowed session cannot lock its owner out.
   */
  app.post('/:id/password', requireAccountAdmin, async (c) => {
    const target = c.req.param('id');
    const body = SetAccountPasswordRequestSchema.parse(await c.req.json());
    const self = callerAccountId(c) === target;
    return answer(c, async () => ({
      account: await accounts().setPassword(target, body.password, {
        requireCurrent: self,
        ...(body.currentPassword !== undefined ? { currentPassword: body.currentPassword } : {}),
        ...(self && c.get('auth')?.accountSessionId
          ? { keepSessionId: c.get('auth')?.accountSessionId }
          : {}),
      }),
    }));
  });

  app.delete('/:id', requireAccountAdmin, async (c) => {
    return answer(c, async () => {
      await accounts().remove(c.req.param('id'));
      return { removed: true };
    });
  });

  app.get('/:id/sessions', requireAccountAdmin, (c) => {
    const body: AccountSessionListResponse = {
      sessions: accounts().listSessions(c.req.param('id'), c.get('auth')?.accountSessionId),
    };
    return c.json(body);
  });

  app.delete('/sessions/:sessionId', requireAccountAdmin, async (c) => {
    return c.json({ revoked: await accounts().revokeSession(c.req.param('sessionId')) });
  });

  app.post('/:id/sign-out-all', requireAccountAdmin, async (c) => {
    const target = c.req.param('id');
    const keep = callerAccountId(c) === target ? c.get('auth')?.accountSessionId : undefined;
    return c.json({ signedOut: await accounts().revokeAll(target, keep) });
  });

  /**
   * A fresh setup link, while no account exists. Only the owner's own
   * credential (the container's shell) may ask: a browser that could reach
   * this would not need it.
   */
  app.post('/setup-link', (c) => {
    if (callerAccountId(c) !== undefined) return c.json({ error: 'forbidden' }, 403);
    if (accounts().hasAccounts()) {
      return c.json({ error: 'setup_closed', message: 'This Gezel already has an account.' }, 409);
    }
    if (ctx.announceSetupLink) return c.json(ctx.announceSetupLink() ?? { code: null });
    return c.json({ code: accounts().mintSetupCode() });
  });

  return app;
}

async function answer(c: Context, run: () => Promise<object>, status: 200 | 201 = 200) {
  try {
    return c.json(await run(), status);
  } catch (err) {
    if (!(err instanceof AccountError)) throw err;
    const code =
      err.code === 'not_found'
        ? 404
        : err.code === 'name_taken' || err.code === 'last_admin'
          ? 409
          : 400;
    return c.json({ error: err.code, message: err.message }, code);
  }
}
