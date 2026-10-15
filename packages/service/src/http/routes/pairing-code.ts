/**
 * Showing and withdrawing this device's connect code. Mounted on the user
 * daemon at `/api/remote-serving/pairing-code`, and on the machine engine
 * inside `/v1/remote/manage/serving` (reached from a user daemon through
 * `/api/machine-serving/pairing-code`), so it always belongs to whichever
 * daemon owns the LAN listener. Loopback and first-party only: the code is a
 * credential for as long as it shows.
 *
 *   GET    → { code: string | null, expiresAt?, attemptsLeft?, lastPaired? }
 *   POST   → a fresh code (409 while the listener is off)
 *   DELETE → withdraw it
 */

import { Hono } from 'hono';
import type { EngineContext } from '../engine-context.js';

export function pairingCodeRoutes(ctx: EngineContext): Hono {
  const app = new Hono();

  const describe = () => {
    const current = ctx.remoteServing.status().listening ? ctx.pairingCodes.current() : null;
    const lastPaired = ctx.pairingCodes.lastPaired();
    return {
      code: current?.code ?? null,
      ...(current ? { expiresAt: current.expiresAt, attemptsLeft: current.attemptsLeft } : {}),
      ...(lastPaired ? { lastPaired } : {}),
    };
  };

  app.get('/', (c) => c.json(describe()));

  app.post('/', (c) => {
    if (!ctx.remoteServing.status().listening) {
      return c.json(
        {
          error: 'not_serving',
          message:
            'Turn on sharing first; a connect code only works while other devices can reach this one.',
        },
        409,
      );
    }
    ctx.pairingCodes.open();
    return c.json(describe());
  });

  app.delete('/', (c) => {
    ctx.pairingCodes.close();
    return c.json(describe());
  });

  return app;
}
