import { describe, expect, it, vi } from 'vitest';
import { ensurePrivateUserHome } from './home-permissions.js';

describe('ensurePrivateUserHome', () => {
  it('creates and repairs a Unix home with mode 0700', async () => {
    const mkdir = vi.fn(async () => undefined);
    const chmod = vi.fn(async () => undefined);

    await ensurePrivateUserHome('/home/alice/.gezel', {
      platform: 'linux',
      mkdir,
      chmod,
    });

    expect(mkdir).toHaveBeenCalledWith('/home/alice/.gezel', {
      recursive: true,
      mode: 0o700,
    });
    expect(chmod).toHaveBeenCalledWith('/home/alice/.gezel', 0o700);
    expect(mkdir.mock.invocationCallOrder[0]!).toBeLessThan(chmod.mock.invocationCallOrder[0]!);
  });

  it('does not use POSIX modes on Windows', async () => {
    const mkdir = vi.fn(async () => undefined);
    const chmod = vi.fn(async () => undefined);

    await ensurePrivateUserHome('C:\\Users\\Alice\\.gezel', {
      platform: 'win32',
      mkdir,
      chmod,
    });

    expect(mkdir).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
  });

  it('fails closed when an existing home cannot be repaired', async () => {
    const cause = new Error('operation not permitted');

    await expect(
      ensurePrivateUserHome('/home/alice/.gezel', {
        platform: 'linux',
        mkdir: async () => undefined,
        chmod: async () => {
          throw cause;
        },
      }),
    ).rejects.toMatchObject({
      message: 'Unable to secure the private Gezel home at /home/alice/.gezel with mode 0700',
      cause,
    });
  });
});
