import { Hono } from 'hono';
import { readSdkTypes } from '../../scripts/sdk.js';

/**
 * Serves the `@bendyline/gezel-sdk` typings to the in-app script editor.
 *
 *   GET /api/sdk/types — { version, files: [{ name, content }] }
 *
 * Served from the daemon (not bundled into the UI) so Monaco's
 * IntelliSense always matches the SDK this service vendors into the
 * script sandbox — the UI can attach to daemons of other versions.
 * `version` is a content hash, doubled as the ETag.
 */
export function sdkTypesRoutes(): Hono {
  const app = new Hono();

  app.get('/types', async (c) => {
    const types = await readSdkTypes();
    if (c.req.header('if-none-match') === types.version) {
      return c.body(null, 304);
    }
    c.header('ETag', types.version);
    return c.json(types);
  });

  return app;
}
