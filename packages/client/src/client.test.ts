import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from './client.js';

describe('GezelClient task refs', () => {
  it('rejects malformed task refs without throwing synchronously', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    const request = client.getTaskByRef('Spanish Lang');

    await expect(request).rejects.toThrow('invalid task ref "Spanish Lang"');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('GezelClient health', () => {
  it('forwards an AbortSignal to the health request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(
        JSON.stringify({ ok: true, startedAt: '2026-01-01T00:00:00.000Z', version: '1.0.0' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await expect(client.health(controller.signal)).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('GezelClient typed project creation', () => {
  it('uses the server-owned atomic creation endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://test/api/projects/typed');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        name: 'Spanish Practice',
        projectType: { typeId: 'language-trainer', params: { language: 'Spanish' } },
      });
      return new Response(JSON.stringify({ project: { id: 'spanish-practice' }, applied: {} }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await client.createTypedProject({
      name: 'Spanish Practice',
      projectType: { typeId: 'language-trainer', params: { language: 'Spanish' } },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
