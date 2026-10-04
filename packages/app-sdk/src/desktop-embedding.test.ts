import { describe, expect, it, vi } from 'vitest';
import { createDesktopEmbedding } from './desktop-embedding.js';
import { connectOrHost } from './gezel.js';
vi.mock('./gezel.js', () => ({ connectOrHost: vi.fn() }));
describe('desktop embedding policy', () => {
  it('requests only inference, keeps initial connection silent, prompts only on reconnect', async () => {
    const close = vi.fn(async () => {});
    vi.mocked(connectOrHost).mockResolvedValue({
      hosting: false,
      openai: { models: async () => ({ object: 'list', data: [] }) },
      close,
    } as never);
    const onVerificationCode = vi.fn();
    const host = createDesktopEmbedding({
      appId: 'fixture',
      appName: 'Fixture',
      host: {},
      onVerificationCode,
    });
    await host.setEnabled(true);
    await host.models.list();
    expect(connectOrHost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scopes: ['openai'],
        requireVerificationCode: true,
        host: expect.objectContaining({
          mode: 'in-process',
          inferenceOnly: true,
          systemBootstrap: false,
        }),
      }),
    );
    expect(vi.mocked(connectOrHost).mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'onVerificationCode',
    );
    await host.reconnect();
    expect(vi.mocked(connectOrHost).mock.calls.at(-1)?.[0].onVerificationCode).toBe(
      onVerificationCode,
    );
    await host.close();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
