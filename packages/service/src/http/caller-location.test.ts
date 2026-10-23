import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { callerMaySeeLocation } from './caller-location.js';
import type { ServiceContext } from './context.js';

function caller(auth: { appId: string; scopes: string[] } | undefined): Context {
  return { get: (key: string) => (key === 'auth' ? auth : undefined) } as unknown as Context;
}

function service(providerName: string | null): ServiceContext {
  return {
    chat: {
      getSessionRecord: async () => (providerName ? { providerName } : null),
    },
  } as unknown as ServiceContext;
}

describe('callerMaySeeLocation', () => {
  it('lets the person’s own clients see where a photo was taken', async () => {
    for (const scopes of [['root'], ['ui', 'openai', 'knowledge'], ['product'], ['cli']]) {
      expect(
        await callerMaySeeLocation(service(null), caller({ appId: 'x', scopes })),
        scopes.join(','),
      ).toBe(true);
    }
  });

  it('decides a session by its provider', async () => {
    const auth = { appId: 'session:s1', scopes: ['session'] };
    expect(await callerMaySeeLocation(service('llama-cpp'), caller(auth))).toBe(true);
    expect(await callerMaySeeLocation(service('anthropic'), caller(auth))).toBe(false);
    expect(await callerMaySeeLocation(service(null), caller(auth))).toBe(false);
  });

  it('withholds location from any other principal', async () => {
    for (const scopes of [['openai'], ['knowledge'], ['harness'], []]) {
      expect(
        await callerMaySeeLocation(service(null), caller({ appId: 'app', scopes })),
        scopes.join(',') || '(none)',
      ).toBe(false);
    }
    expect(await callerMaySeeLocation(service(null), caller(undefined))).toBe(false);
  });
});
