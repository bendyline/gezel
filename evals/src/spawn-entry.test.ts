import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ discoverOrSpawn: vi.fn(), resolveDaemonEntry: vi.fn() }));
vi.mock('@bendyline/gezel-client/node', () => ({
  ...mocks,
  isGezelEngineCommand: vi.fn(),
  listProcessSnapshots: vi.fn(),
  stopOwnedDaemon: vi.fn(),
}));
import { spawnTrialDaemon } from './spawn.ts';

const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('explicit eval daemon artifact', () => {
  it('validates and starts the explicit compiled entry without resolving shared dist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-explicit-entry-'));
    dirs.push(home);
    const daemonEntry = join(home, 'gezeld.js');
    await writeFile(daemonEntry, '// isolated compiled subject\n');
    mocks.discoverOrSpawn.mockResolvedValue({ pid: 1, child: undefined });
    await spawnTrialDaemon({ home, daemonEntry });
    expect(mocks.resolveDaemonEntry).not.toHaveBeenCalled();
    expect(mocks.discoverOrSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ daemonEntry, home }),
    );
  });

  it('rejects an unavailable explicit artifact before spawning', async () => {
    await expect(
      spawnTrialDaemon({
        home: tmpdir(),
        daemonEntry: join(tmpdir(), 'missing-explicit-eval-subject', 'gezeld.js'),
      }),
    ).rejects.toThrow('artifact is unavailable');
    expect(mocks.discoverOrSpawn).not.toHaveBeenCalled();
  });
});
