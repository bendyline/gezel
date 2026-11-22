import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context.js';
import { v1RemoteRoutes } from './v1-remote.js';

function fakeProvider(name: string, calls: string[]) {
  return {
    name,
    generate: async () => {
      calls.push(`${name}:generate`);
      return { png: Buffer.from('png'), meta: { provider: name } };
    },
    listInstalledModels: async () => {
      calls.push(`${name}:models`);
      return [{ id: `${name}-model` }];
    },
    health: async () => {
      calls.push(`${name}:health`);
      return { ok: true, provider: name };
    },
  };
}

function routes(calls: string[]): Hono {
  const ctx = {
    serviceRole: 'machine-engine',
    imageProvider: {
      current: async () => fakeProvider('cloud', calls),
      localProvider: async () => fakeProvider('on-device', calls),
    },
  } as unknown as ServiceContext;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { appId: 'paired-device' } as never);
    await next();
  });
  app.route('/', v1RemoteRoutes(ctx));
  return app;
}

// A paired device rendered on the person's cloud image account whenever that
// was their own pick; the release notes promise on-device models only.
describe('/v1/remote/image', () => {
  it("renders, lists and reports health on the on-device engine, never the person's pick", async () => {
    const calls: string[] = [];
    const app = routes(calls);

    const generated = await app.request('/image/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a lighthouse at dusk' }),
    });
    expect(generated.status).toBe(200);
    expect(await generated.json()).toMatchObject({ meta: { provider: 'on-device' } });

    const models = await app.request('/image/models');
    expect(await models.json()).toEqual({ models: [{ id: 'on-device-model' }] });

    const health = await app.request('/image/health');
    expect(await health.json()).toMatchObject({ provider: 'on-device' });

    expect(calls).toEqual(['on-device:generate', 'on-device:models', 'on-device:health']);
  });
});
