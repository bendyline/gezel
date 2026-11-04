import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LockIdentity, currentLockIdentity } from '@bendyline/gezel/native';
import { afterEach, describe, expect, it } from 'vitest';
import { readForeignLockHolder, readRuntime } from './discovery.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

/** A home whose runtime files name pid 7 on port 16228, locked by `holder`. */
async function homeLockedBy(holder: LockIdentity): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-discovery-'));
  homes.push(home);
  const runtime = join(home, 'runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'pid'), '7');
  await writeFile(join(runtime, 'port'), '16228');
  await writeFile(join(runtime, 'auth-token'), 'token');
  await writeFile(join(runtime, 'lock'), `${holder.pid}\n${JSON.stringify({ v: 1, ...holder })}\n`);
  return home;
}

const otherContainer: LockIdentity = {
  pid: 7,
  hostname: 'another-container',
  pidNs: 'pid:[4026532999]',
};

describe('runtime discovery across pid namespaces', () => {
  it('reads the runtime of a daemon in our own namespace', async () => {
    const home = await homeLockedBy({ ...currentLockIdentity(), pid: 7 });
    expect(await readForeignLockHolder(home)).toBeNull();
    expect(await readRuntime(home)).toMatchObject({ pid: 7, port: 16228 });
  });

  it('ignores the runtime files of a daemon in another container', async () => {
    const home = await homeLockedBy(otherContainer);
    expect(await readRuntime(home)).toBeNull();
    expect(await readForeignLockHolder(home)).toMatchObject({
      holder: { pid: 7, hostname: 'another-container' },
      alive: true,
    });
  });

  it('judges the other container by its heartbeat', async () => {
    const home = await homeLockedBy(otherContainer);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(home, 'runtime', 'lock'), old, old);
    expect(await readForeignLockHolder(home)).toMatchObject({ alive: false });
  });

  it('treats a lock from before the identity record as our own', async () => {
    const home = await homeLockedBy(otherContainer);
    await writeFile(join(home, 'runtime', 'lock'), '7\n');
    expect(await readRuntime(home)).toMatchObject({ pid: 7 });
  });
});
