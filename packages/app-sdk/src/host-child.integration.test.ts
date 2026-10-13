import { mkdtemp, readFile, rm } from 'node:fs/promises';
/**
 * An inference-only app hosted as a child process gets the same surface as
 * one hosted in-process: `gezeld` serves `@bendyline/gezel-inference`'s host
 * behind its loopback listener, with no product API, secrets or identity.
 *
 * Spawns the built `@bendyline/gezel-service/dist/bin/gezeld.js`.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostAsChild } from './host-child.js';
import type { DaemonConnection } from './host-types.js';

let home: string;
let connection: DaemonConnection;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-child-inference-'));
  connection = await hostAsChild('child-inference-test', {
    home,
    mode: 'child',
    inferenceOnly: true,
  });
}, 90_000);

afterAll(async () => {
  await connection?.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
}, 30_000);

const authed = () => ({ headers: { Authorization: `Bearer ${connection.token}` } });

describe('child-hosted inference-only daemon', () => {
  it('runs in its own process and reports the inference profile', async () => {
    expect(connection.mode).toBe('hosted-child');
    expect(connection.pid).not.toBe(process.pid);
    expect(connection.cert).toBeTruthy();
    const health = await connection.fetch(`${connection.baseUrl}/api/health`);
    expect(await health.json()).toMatchObject({ ok: true, profile: 'embedded-inference' });
  });

  it('serves the inference surface and nothing of the product', async () => {
    const { baseUrl, fetch } = connection;
    expect((await fetch(`${baseUrl}/v1/models`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/models`, authed())).status).toBe(200);
    const embeddings = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { ...authed().headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-cpp:any', input: 'hi' }),
    });
    expect(embeddings.status).toBe(400);
    expect(await embeddings.json()).toMatchObject({ error: { code: 'embeddings_not_supported' } });
    for (const path of ['/api/projects', '/api/gezels', '/v1/identity', '/api/remotes']) {
      expect((await fetch(`${baseUrl}${path}`, authed())).status, path).toBe(404);
    }
    for (const name of ['secrets.backend', 'secrets.enc', 'device-identity.json']) {
      await expect(readFile(join(home, name)), name).rejects.toThrow();
    }
  });

  it('stops when the app closes it', async () => {
    const { pid } = connection;
    if (pid === undefined) throw new Error('a child-hosted daemon reports its pid');
    await connection.close();
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(false);
  });
});
