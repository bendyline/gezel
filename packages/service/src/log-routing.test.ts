import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLogger,
  getLogLevel,
  getLogOutput,
  getLogSink,
  setLogLevel,
  setLogOutput,
} from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeServiceLogs } from './log-routing.js';

describe('routeServiceLogs', () => {
  let home: string | undefined;
  const initialOutput = getLogOutput();
  const initialLevel = getLogLevel();

  afterEach(async () => {
    vi.restoreAllMocks();
    setLogOutput(initialOutput);
    setLogLevel(initialLevel);
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  function capture(stream: NodeJS.WriteStream): string[] {
    const lines: string[] = [];
    vi.spyOn(stream, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof stream.write);
    return lines;
  }

  it("keeps a CLI-hosted service's records in the service log and prints only errors", async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-log-routing-'));
    setLogLevel('info');
    const restore = routeServiceLogs('file', home);
    const stdout = capture(process.stdout);
    const stderr = capture(process.stderr);
    const log = createLogger('tasks');
    log.info('[tasks] booted');
    log.warn('[tasks] default/1 runs stepwise: the book has no contract');
    log.error('[tasks] reference search failed');
    await restore();
    vi.restoreAllMocks();

    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('ERROR [tasks] reference search failed');
    expect(getLogSink()).toBeNull();
    expect(getLogOutput()).toBe(initialOutput);

    const logs = join(home, 'logs');
    const [file] = (await readdir(logs)).filter((name) => name.startsWith('service-'));
    const text = await readFile(join(logs, file ?? ''), 'utf8');
    expect(text).toContain('INFO  [tasks] booted');
    expect(text).toContain('WARN  [tasks] default/1 runs stepwise');
    expect(text).toContain('ERROR [tasks] reference search failed');
    expect(text).not.toContain('[tasks] [tasks]');
  });

  it('sends records to stderr, and restores the previous output, for a library host', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-log-routing-'));
    setLogOutput('split');
    const restore = routeServiceLogs('stderr', home);
    expect(getLogOutput()).toBe('stderr');
    await restore();
    expect(getLogOutput()).toBe('split');
  });
});
