import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeNativeReceipt } from './receipt-transport.ts';

describe('native feedback transport cleanup', () => {
  it('preserves exact receipt bytes and propagates unsuccessful writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gezel-receipt-'));
    try {
      const path = join(directory, 'receipt.json');
      const encoded = JSON.stringify({ answer: 'café\n"complete"', requestId: 'same-receipt' });
      await writeNativeReceipt(
        process.execPath,
        [
          '-e',
          'let data=""; process.stdin.on("data",b=>data+=b).on("end",()=>require("node:fs").writeFileSync(process.argv[1],data));',
          path,
        ],
        encoded,
        { signal: new AbortController().signal },
      );
      expect(await readFile(path, 'utf8')).toBe(encoded);
      await expect(
        writeNativeReceipt(
          process.execPath,
          ['-e', 'process.stderr.write("denied"); process.exit(2)'],
          encoded,
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('bounds a hung write and closes its process before the promise settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gezel-receipt-timeout-'));
    try {
      const pidPath = join(directory, 'pid');
      await expect(
        writeNativeReceipt(
          process.execPath,
          [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1],String(process.pid)); process.stdin.resume(); setInterval(()=>{},1000);',
            pidPath,
          ],
          '{}',
          { signal: new AbortController().signal, timeoutMs: 500 },
        ),
      ).rejects.toThrow('timed out');
      const pid = Number(await readFile(pidPath, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('aborts an active write and refuses to start after cancellation', async () => {
    const abort = new AbortController();
    const writing = writeNativeReceipt(
      process.execPath,
      ['-e', 'process.stdin.resume(); setInterval(()=>{},1000);'],
      '{}',
      { signal: abort.signal },
    );
    abort.abort(new Error('Native test finished'));
    await expect(writing).rejects.toThrow('Native test finished');
    await expect(
      writeNativeReceipt('/should-not-spawn', [], '{}', { signal: abort.signal }),
    ).rejects.toThrow('Native test finished');
  });
});
