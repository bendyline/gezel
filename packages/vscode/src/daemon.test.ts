import { describe, expect, it, vi } from 'vitest';

const authorizeLocal = vi.hoisted(() => vi.fn());
const GezelApp = vi.hoisted(
  () =>
    class {
      constructor(readonly options: unknown) {}
    },
);

vi.mock('@bendyline/gezel-app-sdk', () => ({
  authorizeLocal,
  GezelApp,
}));

const { acquireAppConnection } = await import('./daemon.js');

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('VS Code app authorization', () => {
  it('delegates local discovery, safe optional startup, TLS, and consent to the app SDK', async () => {
    const secrets = new Map<string, string>();
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    authorizeLocal.mockImplementationOnce(async (input) => {
      expect(input).toMatchObject({
        appId: 'vscode',
        appName: 'Visual Studio Code',
        scopes: ['product', 'openai'],
        daemon: {
          spawnIfMissing: true,
          timeoutMs: 20_000,
        },
      });
      expect(input.daemon.daemonEntry).toMatch(/gezeld\.js$/);
      await input.onVerificationCode('XA2-M6N');
      await input.tokenStorage.save(input.appId, 'VS-CODE-TOKEN');
      return {
        baseUrl: 'https://127.0.0.1:54321',
        token: 'VS-CODE-TOKEN',
        fetch,
        daemon: { mode: 'spawned', pid: 1234, cert: 'PUBLIC-CERT' },
      };
    });

    const context = {
      secrets: {
        store: async (key: string, value: string) => secrets.set(key, value),
        get: async (key: string) => secrets.get(key),
        delete: async (key: string) => {
          secrets.delete(key);
        },
      },
    } as unknown as import('vscode').ExtensionContext;
    const onVerificationCode = vi.fn();

    const result = await acquireAppConnection(
      {
        daemonUrl: undefined,
        daemonToken: undefined,
        defaultGezel: 'dev',
        spawnIfMissing: true,
      },
      context,
      logger(),
      onVerificationCode,
    );

    expect(onVerificationCode).toHaveBeenCalledWith('XA2-M6N');
    expect(result.app).toBeInstanceOf(GezelApp);
    expect(result.appToken).toBe('VS-CODE-TOKEN');
    expect(result.connection).toMatchObject({
      baseUrl: 'https://127.0.0.1:54321',
      token: 'VS-CODE-TOKEN',
      mode: 'spawned',
      pid: 1234,
      cert: 'PUBLIC-CERT',
    });
    expect(result.connection).not.toHaveProperty('firstPartyToken');
  });

  it('passes an explicitly configured connection through the same SDK protocol', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    authorizeLocal.mockImplementationOnce(async (input) => {
      expect(input).toMatchObject({
        baseUrl: 'https://127.0.0.1:7443',
        existingToken: 'CONFIGURED-TOKEN',
      });
      expect(input.daemon).toBeUndefined();
      return {
        baseUrl: input.baseUrl,
        token: input.existingToken,
        fetch,
        daemon: { mode: 'configured', cert: null },
      };
    });
    const context = {
      secrets: {
        store: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as import('vscode').ExtensionContext;

    const result = await acquireAppConnection(
      {
        daemonUrl: 'https://127.0.0.1:7443',
        daemonToken: 'CONFIGURED-TOKEN',
        defaultGezel: 'dev',
        spawnIfMissing: false,
      },
      context,
      logger(),
      vi.fn(),
    );

    expect(result.connection.mode).toBe('configured');
    expect(result.connection.token).toBe('CONFIGURED-TOKEN');
  });
});
