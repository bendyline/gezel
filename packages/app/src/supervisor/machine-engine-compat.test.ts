import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  runtime: null as null | {
    baseUrl: string;
    token: string;
    cert: string | null;
    serviceRole?: 'user' | 'machine-engine' | 'legacy-full';
  },
  fetch: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock('./system-service.js', () => ({
  systemServiceHome: () => '/var/lib/gezel',
  readSystemServiceRuntime: () => Promise.resolve(ctx.runtime),
}));

vi.mock('@bendyline/gezel-client/node', () => ({
  createTrustingFetch: () => Object.assign(ctx.fetch, { close: ctx.close }),
}));

const { inspectMachineEngineCompatibility } = await import('./machine-engine-compat.js');

beforeEach(() => {
  vi.clearAllMocks();
  ctx.runtime = {
    baseUrl: 'https://127.0.0.1:6228',
    token: 'machine-token',
    cert: 'CERT',
    serviceRole: 'machine-engine',
  };
});

describe('machine-engine compatibility preflight', () => {
  it('reports the installed version when native capacity coordination is missing', async () => {
    ctx.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'not_found', service: 'gezel-machine-engine' }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, version: '1.26244.63' }), { status: 200 }),
      );

    await expect(inspectMachineEngineCompatibility()).resolves.toEqual({
      source: 'machine-engine',
      capability: 'native-capacity-v1',
      serviceHome: '/var/lib/gezel',
      installedVersion: '1.26244.63',
    });
    expect(ctx.fetch.mock.calls[0]?.[0]).toContain('/v1/remote/manage/native-capacity');
    expect(JSON.parse(ctx.fetch.mock.calls[0]?.[1].body)).toMatchObject({ action: 'status' });
    expect(ctx.fetch.mock.calls[1]?.[0]).toContain('/api/health');
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('stays quiet when the installed broker supports the capability', async () => {
    ctx.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'released', releaseRequested: false }), { status: 200 }),
    );

    await expect(inspectMachineEngineCompatibility()).resolves.toBeNull();
    expect(ctx.fetch).toHaveBeenCalledOnce();
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('does not misclassify a transient broker failure as an old version', async () => {
    ctx.fetch.mockRejectedValueOnce(new Error('connection reset'));

    await expect(inspectMachineEngineCompatibility()).resolves.toBeNull();
    expect(ctx.close).toHaveBeenCalledOnce();
  });
});
