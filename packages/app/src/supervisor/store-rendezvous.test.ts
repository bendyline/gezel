import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appGroupRendezvousDir,
  findStoreRendezvous,
  readRendezvousDir,
} from './store-rendezvous.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-rendezvous-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRendezvous(files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
}

describe('readRendezvousDir', () => {
  it('reads a plain-HTTP rendezvous', async () => {
    await writeRendezvous({ port: '6228\n', 'auth-token': 'tok\n' });
    expect(await readRendezvousDir(dir, 'app-group-mirror')).toEqual({
      baseUrl: 'http://127.0.0.1:6228',
      token: 'tok',
      cert: null,
      source: 'app-group-mirror',
    });
  });

  it('infers HTTPS from cert presence, matching the primary reader', async () => {
    await writeRendezvous({ port: '6228', 'auth-token': 'tok', 'cert.pem': '---PEM---' });
    const found = await readRendezvousDir(dir, 'user-profile-runtime');
    expect(found?.baseUrl).toBe('https://127.0.0.1:6228');
    expect(found?.cert).toBe('---PEM---');
  });

  it('returns null when the token is missing', async () => {
    // A half-written directory is indistinguishable from a daemon mid-launch.
    // Connecting without a credential would only produce a confusing 401.
    await writeRendezvous({ port: '6228' });
    expect(await readRendezvousDir(dir, 'app-group-mirror')).toBeNull();
  });

  it('returns null for an unusable port rather than building a bad URL', async () => {
    await writeRendezvous({ port: 'not-a-port', 'auth-token': 'tok' });
    expect(await readRendezvousDir(dir, 'app-group-mirror')).toBeNull();
  });

  it('returns null for an empty token file', async () => {
    await writeRendezvous({ port: '6228', 'auth-token': '   \n' });
    expect(await readRendezvousDir(dir, 'app-group-mirror')).toBeNull();
  });

  it('returns null when the directory does not exist', async () => {
    expect(await readRendezvousDir(join(dir, 'nope'), 'app-group-mirror')).toBeNull();
  });

  it('never exposes a pid, even when one is present on disk', async () => {
    // The mirror does not publish one, and a store build must not manage a
    // daemon it did not spawn. Not returning it is what keeps later code from
    // being tempted.
    await writeRendezvous({ port: '6228', 'auth-token': 'tok', pid: '4242' });
    const found = await readRendezvousDir(dir, 'app-group-mirror');
    expect(found).not.toHaveProperty('pid');
  });
});

describe('findStoreRendezvous', () => {
  it('reads the App Group container on macOS', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-home-'));
    try {
      const groupDir = appGroupRendezvousDir(home);
      await mkdir(groupDir, { recursive: true });
      await writeFile(join(groupDir, 'port'), '6300', 'utf8');
      await writeFile(join(groupDir, 'auth-token'), 'mac-tok', 'utf8');
      const found = await findStoreRendezvous({ platform: 'darwin', home });
      expect(found).toMatchObject({ token: 'mac-tok', source: 'app-group-mirror' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reads the real user profile on Windows, where MSIX can see it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-home-'));
    try {
      const runtime = join(home, '.gezel', 'runtime');
      await mkdir(runtime, { recursive: true });
      await writeFile(join(runtime, 'port'), '6228', 'utf8');
      await writeFile(join(runtime, 'auth-token'), 'win-tok', 'utf8');
      const found = await findStoreRendezvous({ platform: 'win32', home });
      expect(found).toMatchObject({ token: 'win-tok', source: 'user-profile-runtime' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('finds nothing on Linux, which has no store channel', async () => {
    expect(await findStoreRendezvous({ platform: 'linux', home: dir })).toBeNull();
  });

  it('returns null rather than throwing when no direct install exists', async () => {
    // The ordinary case on a machine with only the store build. It must be
    // silent: there is nothing degraded to report.
    const home = await mkdtemp(join(tmpdir(), 'gezel-empty-'));
    try {
      expect(await findStoreRendezvous({ platform: 'darwin', home })).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('honors an explicit override on any platform', async () => {
    await writeRendezvous({ port: '6400', 'auth-token': 'override' });
    const found = await findStoreRendezvous({ platform: 'linux', overrideDir: dir });
    expect(found?.token).toBe('override');
  });
});
