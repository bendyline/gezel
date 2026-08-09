/**
 * The runtime-directory contract, tested at the credential level: which
 * files the daemon publishes, at which POSIX modes, and what the published
 * credential can actually reach. This is the mechanism behind "any local
 * account that can read the runtime dir is a first-party client" — the 0644
 * system-scope branch — and behind the machine token's confinement to
 * inference. The root token must never land in any of these files.
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from './service.js';

const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorSecrets = process.env.GEZEL_SECRETS_BACKEND;
const priorSystemScope = process.env.GEZEL_SYSTEM_SCOPE;

beforeAll(() => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SECRETS_BACKEND = 'file';
});

afterAll(() => {
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorSecrets === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
  else process.env.GEZEL_SECRETS_BACKEND = priorSecrets;
  if (priorSystemScope === undefined) delete process.env.GEZEL_SYSTEM_SCOPE;
  else process.env.GEZEL_SYSTEM_SCOPE = priorSystemScope;
});

async function fileMode(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

async function assertRootTokenNowhereOnDisk(svc: RunningService, home: string): Promise<void> {
  const runtimeDir = join(home, 'runtime');
  for (const file of await readdir(runtimeDir)) {
    const content = await readFile(join(runtimeDir, file), 'utf8').catch(() => '');
    expect(content.includes(svc.context.token), `root token leaked into runtime/${file}`).toBe(
      false,
    );
  }
}

describe.skipIf(process.platform === 'win32')('runtime directory contract (POSIX)', () => {
  describe('system scope (machine service)', () => {
    let svc: RunningService;
    let home: string;

    beforeAll(async () => {
      process.env.GEZEL_SYSTEM_SCOPE = '1';
      home = await mkdtemp(join(tmpdir(), 'gezel-runtime-sys-'));
      svc = await startService({ home, role: 'machine-engine' });
    }, 60_000);

    afterAll(async () => {
      if (priorSystemScope === undefined) delete process.env.GEZEL_SYSTEM_SCOPE;
      else process.env.GEZEL_SYSTEM_SCOPE = priorSystemScope;
      await svc?.stop();
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }, 30_000);

    it('publishes discovery files world-readable (0644) — the documented membership mechanism', async () => {
      for (const file of ['port', 'pid', 'service-role', 'auth-token']) {
        expect(await fileMode(join(home, 'runtime', file)), file).toBe('644');
      }
      expect(await fileMode(join(home, 'runtime', 'cert.pem'))).toBe('644');
    });

    it('publishes the scoped client credential, never the root token', async () => {
      const disk = (await readFile(join(home, 'runtime', 'auth-token'), 'utf8')).trim();
      expect(disk).toBe(svc.clientToken);
      expect(disk).not.toBe(svc.context.token);
      await assertRootTokenNowhereOnDisk(svc, home);
    });

    it('confines the published credential to inference at the credential level', async () => {
      // Not the route-table proof (machine-engine-boundary.test.ts) — this
      // reads the 0644 file exactly as another local account would and pins
      // the middleware-level denial on a product route.
      const disk = (await readFile(join(home, 'runtime', 'auth-token'), 'utf8')).trim();
      const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
      const base = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
      const api = await httpFetch(`${base}/api/projects`, {
        headers: { authorization: `Bearer ${disk}` },
      });
      expect(api.status).toBe(403);
      const remote = await httpFetch(`${base}/v1/remote/models`, {
        headers: { authorization: `Bearer ${disk}` },
      });
      expect(remote.status).toBe(200);
    });
  });

  describe('user scope', () => {
    let svc: RunningService;
    let home: string;

    beforeAll(async () => {
      delete process.env.GEZEL_SYSTEM_SCOPE;
      home = await mkdtemp(join(tmpdir(), 'gezel-runtime-user-'));
      svc = await startService({ home, role: 'user' });
    }, 60_000);

    afterAll(async () => {
      await svc?.stop();
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }, 30_000);

    it('keeps discovery files private (0600), cert public (0644)', async () => {
      for (const file of ['port', 'pid', 'service-role', 'auth-token']) {
        expect(await fileMode(join(home, 'runtime', file)), file).toBe('600');
      }
      expect(await fileMode(join(home, 'runtime', 'cert.pem'))).toBe('644');
    });

    it('never writes the root token to disk in user scope either', async () => {
      await assertRootTokenNowhereOnDisk(svc, home);
    });
  });
});
