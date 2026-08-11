import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, describe, expect, it } from 'vitest';
import { type MockServicesRuntime, startMockServices } from './mock-server.ts';

let runtime: MockServicesRuntime | null = null;

afterEach(async () => {
  await runtime?.close();
  runtime = null;
});

describe('mock webhook request evidence', () => {
  it('logs the exact content type and bounded request body received over HTTPS', async () => {
    runtime = await startMockServices([
      {
        kind: 'webhook',
        id: 'receiver',
        description: 'Fetch URL probe receiver.',
        path: '/ingest/fetch-url',
      },
    ] as never);
    expect(runtime).toBeTruthy();

    const service = runtime!.services.get('receiver')!;
    const trustingFetch = createTrustingFetch({ cert: runtime!.caPem });
    const body = '{"probe":"GEZEL-FETCH-URL-E2E-v1"}';
    const response = await trustingFetch(`${service.baseUrl}/ingest/fetch-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(service.requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/ingest/fetch-url',
        status: 200,
        contentType: 'application/json',
        requestBody: body,
      }),
    ]);
    expect(service.requests[0]?.requestBodyTruncated).not.toBe(true);
  });
});
