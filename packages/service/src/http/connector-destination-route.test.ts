import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorPolicyError } from '../connectors/manager.js';
import type { ServiceContext } from './context.js';
import { connectorRoutes } from './routes/connectors.js';

/**
 * Where a connector sends its credential (a server, an API base, a host)
 * changes only from the app's own credential. `manager-destinations` pins the
 * refusal inside `patchBinding`; this pins the one route that reaches it, so
 * an approved app (`cli`, `product`) or a gezel session never counts as the
 * person's app. Counted as one, it could point a binding at itself and
 * receive the sign-in on the next sync.
 */

const CALLERS: Array<{ name: string; auth: Record<string, unknown>; firstParty: boolean }> = [
  {
    name: 'the daemon’s own credential',
    auth: { appId: 'root', scopes: ['root'] },
    firstParty: true,
  },
  { name: 'the desktop app', auth: { appId: 'desktop-client', scopes: ['ui'] }, firstParty: true },
  { name: 'an approved CLI', auth: { appId: 'cli:1', scopes: ['cli'] }, firstParty: false },
  {
    name: 'an approved app',
    auth: { appId: 'app:docblocks', scopes: ['product'] },
    firstParty: false,
  },
  {
    name: 'a gezel session',
    auth: { appId: 'session:s1', scopes: ['session'], projectId: 'p1', gezelId: 'gz-1' },
    firstParty: false,
  },
];

function harness(auth: Record<string, unknown>, refuse = false) {
  const patchBinding = vi.fn(
    async (_project: unknown, _id: string, patch: { firstParty?: boolean }) => {
      if (refuse && !patch.firstParty) {
        throw new ConnectorPolicyError(
          'where this connection sends its sign-in changes only in Gezel',
        );
      }
      return { id: 'mail-imap:1' };
    },
  );
  const ctx = {
    store: { getProject: async () => ({ id: 'p1', connectors: [] }) },
    connectors: { patchBinding },
  } as unknown as ServiceContext;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as never);
    await next();
  });
  app.route('/api/projects', connectorRoutes(ctx));
  const patch = () =>
    app.request('/api/projects/p1/connectors/mail-imap:1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { host: 'imap.attacker.example' } }),
    });
  return { patch, patchBinding };
}

describe('connector destination moves', () => {
  it.each(CALLERS)('tells the manager whether $name is the person’s own app', async (caller) => {
    const { patch, patchBinding } = harness(caller.auth);
    expect((await patch()).status).toBe(200);
    expect(patchBinding.mock.calls[0]![2].firstParty).toBe(caller.firstParty);
  });

  it('answers the manager’s refusal with a 403 the caller can read', async () => {
    const { patch } = harness({ appId: 'cli:1', scopes: ['cli'] }, true);
    const res = await patch();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/only in Gezel/);
  });
});
