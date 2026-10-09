import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecognitionManager } from './manager.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-recog-engine-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('RecognitionManager without a llama.cpp engine', () => {
  it('starts the engine download, says so, and uses the engine once it lands', async () => {
    const env: NodeJS.ProcessEnv = {};
    const ensureEngine = vi.fn(async () => ({
      detail: 'On-device engine (llama-server, metal) is downloading (40%).',
    }));
    const manager = new RecognitionManager({ home, env, ensureEngine });

    const waiting = await manager.health();
    expect(waiting).toEqual({
      state: 'not-configured',
      detail: 'On-device engine (llama-server, metal) is downloading (40%).',
    });
    expect(ensureEngine).toHaveBeenCalledTimes(1);
    expect(await manager.isAvailable()).toBe(false);

    // The resolver stamps the engine path when the download finishes.
    env.GEZEL_LLAMA_SERVER_BIN = join(home, 'gezel-llama-server');
    const ready = await manager.health();
    expect(ready.state).not.toBe('not-configured');
    expect(ensureEngine).toHaveBeenCalledTimes(2);
  });
});
