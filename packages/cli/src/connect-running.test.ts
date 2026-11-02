import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NO_RUNNING_SERVICE_MESSAGE, connectRunning } from './connection.js';

describe('--no-start (connectRunning)', () => {
  const globals = () => ({ home: mkdtempSync(join(tmpdir(), 'gezel-no-start-')) });

  it('refuses, without starting anything, when no service is running', async () => {
    const connectOwned = vi.fn();
    await expect(
      connectRunning(globals(), { readRuntime: async () => null, connectOwned }),
    ).rejects.toThrow(NO_RUNNING_SERVICE_MESSAGE);
    expect(connectOwned).not.toHaveBeenCalled();
  });

  it('treats a runtime file left by a dead daemon as nothing running', async () => {
    const connectOwned = vi.fn();
    await expect(
      connectRunning(globals(), {
        readRuntime: async () => ({ pid: 999_999 }) as never,
        isAlive: () => false,
        connectOwned,
      }),
    ).rejects.toThrow(/--no-start/);
    expect(connectOwned).not.toHaveBeenCalled();
  });

  it('adopts a live daemon quietly', async () => {
    const client = { marker: true };
    const connectOwned = vi.fn().mockResolvedValue(client);
    const g = globals();
    await expect(
      connectRunning(g, {
        readRuntime: async () => ({ pid: 1234 }) as never,
        isAlive: () => true,
        connectOwned,
      }),
    ).resolves.toBe(client);
    expect(connectOwned).toHaveBeenCalledWith(g, { announceSpawn: false });
  });
});
