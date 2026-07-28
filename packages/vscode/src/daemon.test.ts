import { describe, expect, it, vi } from 'vitest';
import type { Connection } from './daemon.js';

const sdkAuthorize = vi.hoisted(() => vi.fn());
const GezelApp = vi.hoisted(
  () =>
    class {
      constructor(readonly options: unknown) {}
    },
);

vi.mock('@bendyline/gezel-app-sdk', () => ({
  authorize: sdkAuthorize,
  GezelApp,
}));

const { acquireAppConnection } = await import('./daemon.js');

describe('VS Code app authorization', () => {
  it('requests one code-verified product + inference grant for both VS Code surfaces', async () => {
    const secrets = new Map<string, string>();
    const onVerificationCode = vi.fn();
    sdkAuthorize.mockImplementationOnce(async (input) => {
      expect(input).toMatchObject({
        appId: 'vscode',
        appName: 'Visual Studio Code',
        scopes: ['product', 'openai'],
      });
      await input.onVerificationCode('XA2-M6N');
      await input.tokenStorage.save(input.appId, 'VS-CODE-TOKEN');
      return {
        baseUrl: input.baseUrl,
        token: 'VS-CODE-TOKEN',
        fetch: input.fetch,
      };
    });

    const connection = {
      baseUrl: 'https://127.0.0.1:43935',
      fetch: vi.fn(),
      token: 'FIRST-PARTY',
      firstPartyToken: 'FIRST-PARTY',
    } as unknown as Connection;
    const context = {
      secrets: {
        store: async (key: string, value: string) => {
          secrets.set(key, value);
        },
        get: async (key: string) => secrets.get(key),
      },
    } as unknown as import('vscode').ExtensionContext;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    };

    const result = await acquireAppConnection(connection, context, logger, onVerificationCode);

    expect(onVerificationCode).toHaveBeenCalledWith('XA2-M6N');
    expect(result.app).toBeInstanceOf(GezelApp);
    expect(result.appToken).toBe('VS-CODE-TOKEN');
    expect(result.connection.token).toBe('VS-CODE-TOKEN');
    expect(result.connection.firstPartyToken).toBe('FIRST-PARTY');
  });

  it('self-revokes a saved inference-only token before requesting product access', async () => {
    const secrets = new Map<string, string>([['gezel:vscode', 'OLD-OPENAI-TOKEN']]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    sdkAuthorize.mockImplementationOnce(async (input) => {
      expect(await input.tokenStorage.load(input.appId)).toBeNull();
      await input.tokenStorage.save(input.appId, 'PRODUCT-TOKEN');
      return {
        baseUrl: input.baseUrl,
        token: 'PRODUCT-TOKEN',
        fetch: input.fetch,
      };
    });

    const connection = {
      baseUrl: 'https://127.0.0.1:43935',
      fetch,
      token: 'FIRST-PARTY',
      firstPartyToken: 'FIRST-PARTY',
    } as unknown as Connection;
    const context = {
      secrets: {
        store: async (key: string, value: string) => secrets.set(key, value),
        get: async (key: string) => secrets.get(key),
        delete: async (key: string) => {
          secrets.delete(key);
        },
      },
    } as unknown as import('vscode').ExtensionContext;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    };

    const result = await acquireAppConnection(connection, context, logger, vi.fn());

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://127.0.0.1:43935/api/config',
      expect.objectContaining({
        headers: { Authorization: 'Bearer OLD-OPENAI-TOKEN' },
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://127.0.0.1:43935/v1/apps/vscode/token',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer OLD-OPENAI-TOKEN' },
      }),
    );
    expect(result.appToken).toBe('PRODUCT-TOKEN');
  });
});
