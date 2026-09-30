import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installDaemonLogFile } from './daemon-log-file.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function scratchHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-daemon-log-'));
  homes.push(home);
  return home;
}

function fakeStream() {
  const received: unknown[] = [];
  const stream = {
    write: (chunk: unknown) => {
      received.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, received };
}

function todaysLog(home: string): string {
  return join(home, 'logs', `service-${new Date().toISOString().slice(0, 10)}.log`);
}

describe('installDaemonLogFile', () => {
  it('does nothing unless the spawner asked for a log file', async () => {
    const home = await scratchHome();
    const { stream } = fakeStream();
    const original = stream.write;
    expect(installDaemonLogFile({ env: { GEZEL_HOME: home }, streams: [stream] })).toBeNull();
    expect(stream.write).toBe(original);
    expect(existsSync(join(home, 'logs'))).toBe(false);
  });

  it('mirrors text and binary writes into the rotated service log, passing them through unchanged', async () => {
    const home = await scratchHome();
    const { stream, received } = fakeStream();
    const log = installDaemonLogFile({
      env: { GEZEL_HOME: home, GEZEL_DAEMON_LOG_FILE: '1' },
      streams: [stream],
    });
    stream.write('gezeld listening on https://127.0.0.1:6391\n');
    stream.write(Buffer.from('[chat] session resumed\n'));
    stream.write('\n');
    await log?.close();

    expect(received).toHaveLength(3);
    expect(received[0]).toBe('gezeld listening on https://127.0.0.1:6391\n');
    expect(await readFile(todaysLog(home), 'utf8')).toBe(
      'gezeld listening on https://127.0.0.1:6391\n[chat] session resumed\n',
    );
  });

  it('keeps the one-time web UI token and credential shapes out of the file', async () => {
    const home = await scratchHome();
    const { stream, received } = fakeStream();
    const log = installDaemonLogFile({
      env: { GEZEL_HOME: home, GEZEL_DAEMON_LOG_FILE: '1' },
      streams: [stream],
    });
    stream.write(
      '  Gezel web UI →  http://127.0.0.1:6392/?token=bF4fXka5JtBfXv5w0t153P9HVos5UInx\n',
    );
    stream.write('upstream said Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n');
    await log?.close();

    const written = await readFile(todaysLog(home), 'utf8');
    expect(written).toContain('/?token=[REDACTED]');
    expect(written).not.toContain('bF4fXka5JtBfXv5w0t153P9HVos5UInx');
    expect(written).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    // The terminal, when there is one, still gets the URL it needs.
    expect(received[0]).toContain('bF4fXka5JtBfXv5w0t153P9HVos5UInx');
  });

  it('restores the stream on close', async () => {
    const home = await scratchHome();
    const { stream } = fakeStream();
    const original = stream.write;
    const log = installDaemonLogFile({
      env: { GEZEL_HOME: home, GEZEL_DAEMON_LOG_FILE: '1' },
      streams: [stream],
    });
    expect(stream.write).not.toBe(original);
    await log?.close();
    stream.write('after close\n');
    expect(await readFile(todaysLog(home), 'utf8')).not.toContain('after close');
  });
});
