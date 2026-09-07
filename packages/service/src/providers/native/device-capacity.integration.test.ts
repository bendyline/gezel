import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('atomically admits one of two independent daemon processes against one GPU budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gezel-capacity-processes-'));
  try {
    const code = `
      import { randomUUID } from 'node:crypto';
      import { DeviceCapacityLedger } from ${JSON.stringify(new URL('./device-capacity-ledger.ts', import.meta.url).href)};
      const ledger = new DeviceCapacityLedger({ directory: process.env.TEST_CAPACITY_DIRECTORY,
        sample: async () => ({ budgetBytes: 112 * 1024 ** 3, gpuBudgetBytes: 96 * 1024 ** 3, serializeLoads: false }) });
      const reply = await ledger.execute({ action: 'acquire', id: randomUUID(), ownerPid: Number(process.env.TEST_OWNER_PID),
        label: 'isolated engine', bytes: 83 * 1024 ** 3, gpuBytes: 83 * 1024 ** 3, exclusive: false });
      console.log(reply.state);
    `;
    const run = () =>
      promisify(execFile)(
        process.execPath,
        // Resolve from this service package before starting the child. The
        // child evaluates `-e` from the workspace root, where pnpm correctly
        // does not expose the service package's private `tsx` dev dependency.
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code],
        {
          env: {
            ...process.env,
            TEST_CAPACITY_DIRECTORY: directory,
            TEST_OWNER_PID: String(process.pid),
          },
        },
      );
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => r.stdout.trim()).sort()).toEqual(['granted', 'waiting']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
