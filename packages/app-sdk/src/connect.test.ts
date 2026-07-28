import { describe, expect, it, vi } from 'vitest';
import { authorize, connect } from './connect.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('connect verification codes', () => {
  it('returns the generic authorized transport for a stateful product client', async () => {
    const onVerificationCode = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            grantRequestId: 'product-grant',
            status: 'pending',
            verificationRequired: true,
            verificationCode: 'XA2-M6N',
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'product-grant', status: 'approved', token: 'product-token' }),
      ) as unknown as typeof fetch;

    const authorized = await authorize({
      appId: 'vscode',
      appName: 'Visual Studio Code',
      scopes: ['product', 'openai'],
      baseUrl: 'http://127.0.0.1:43935',
      fetch: fetchImpl,
      onVerificationCode,
    });

    expect(onVerificationCode).toHaveBeenCalledWith('XA2-M6N');
    expect(authorized).toEqual({
      baseUrl: 'http://127.0.0.1:43935',
      token: 'product-token',
      fetch: fetchImpl,
    });
  });

  it('requires a code-display callback before opening a protected grant', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      connect({
        appId: 'missing-handler',
        appName: 'Missing Handler',
        scopes: ['openai'],
        requireVerificationCode: true,
        baseUrl: 'http://127.0.0.1:43935',
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'verification_code_handler_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('delivers a protected grant code to the requesting app before polling', async () => {
    const onVerificationCode = vi.fn();
    const save = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            grantRequestId: 'grant-1',
            status: 'pending',
            verificationRequired: true,
            verificationCode: 'XA2-M6N',
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'grant-1', status: 'approved', token: 'issued-token' }),
      );
    const fetchImpl = fetchMock as unknown as typeof fetch;

    await connect({
      appId: 'stateful-app',
      appName: 'Stateful App',
      scopes: ['openai'],
      requireVerificationCode: true,
      baseUrl: 'http://127.0.0.1:43935',
      fetch: fetchImpl,
      onVerificationCode,
      tokenStorage: { save },
    });

    expect(onVerificationCode).toHaveBeenCalledWith('XA2-M6N');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      scopes: ['openai'],
      requireVerificationCode: true,
    });
    expect(save).toHaveBeenCalledWith('stateful-app', 'issued-token');
    expect(onVerificationCode.mock.invocationCallOrder[0]).toBeLessThan(
      save.mock.invocationCallOrder[0]!,
    );
  });

  it('does not silently downgrade an explicit verification requirement', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ grantRequestId: 'old-daemon-grant', status: 'pending' }, 201),
      ) as unknown as typeof fetch;

    await expect(
      connect({
        appId: 'vscode',
        appName: 'Visual Studio Code',
        scopes: ['openai'],
        requireVerificationCode: true,
        onVerificationCode: () => {},
        baseUrl: 'http://127.0.0.1:43935',
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'verification_not_supported' });
  });

  it('surfaces an expired protected grant distinctly from approval timeout', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            grantRequestId: 'grant-expired',
            status: 'pending',
            verificationRequired: true,
            verificationCode: 'XA2-M6N',
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'grant-expired', status: 'expired' }),
      ) as unknown as typeof fetch;

    await expect(
      connect({
        appId: 'expired-app',
        appName: 'Expired App',
        scopes: ['cli'],
        baseUrl: 'http://127.0.0.1:43935',
        fetch: fetchImpl,
        onVerificationCode: () => {},
      }),
    ).rejects.toMatchObject({ code: 'grant_expired', status: 410 });
  });
});
