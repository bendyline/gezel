import { NativeCapacityCommandSchema } from '@bendyline/gezel';
import { CapacityDeniedError } from '@bendyline/gezel-inference/internal/providers/native/capacity-broker';
import { localDeviceCapacity } from '@bendyline/gezel-inference/internal/providers/native/device-capacity';
import { Hono } from 'hono';

/** Mounted only behind the machine-models scope on the loopback broker. */
export function nativeCapacityRoutes(home: string): Hono {
  const app = new Hono();
  const ledger = localDeviceCapacity(home);
  app.post('/', async (c) => {
    const command = NativeCapacityCommandSchema.parse(await c.req.json());
    try {
      return c.json(await ledger.execute(command));
    } catch (error) {
      if (error instanceof CapacityDeniedError)
        return c.json({ error: error.message, code: error.code }, 409);
      throw error;
    }
  });
  return app;
}
