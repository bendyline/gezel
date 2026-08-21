import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { describeOwnedChildState, formatDiagnosticError } from './diagnostics.js';

describe('supervisor diagnostics', () => {
  it('keeps nested transport causes and error codes', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:44481'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
    });
    const error = new TypeError('fetch failed', { cause });

    expect(formatDiagnosticError(error)).toBe(
      'TypeError: fetch failed <- Error [ECONNREFUSED, connect]: connect ECONNREFUSED 127.0.0.1:44481',
    );
  });

  it('redacts bearer credentials and token-shaped fields', () => {
    const error = new Error(
      'request failed Authorization=super-secret-value https://localhost/?token=url-secret Bearer abcdefghijklmnop',
    );

    const diagnostic = formatDiagnosticError(error);

    expect(diagnostic).toContain('Authorization=[REDACTED]');
    expect(diagnostic).toContain('token=[REDACTED]');
    expect(diagnostic).toContain('Bearer [REDACTED]');
    expect(diagnostic).not.toContain('super-secret-value');
    expect(diagnostic).not.toContain('url-secret');
    expect(diagnostic).not.toContain('abcdefghijklmnop');
  });

  it('captures the Linux state, memory, thread count, and wait channel', async () => {
    const child = {
      pid: 4242,
      killed: true,
      exitCode: null,
      signalCode: null,
    } as unknown as ChildProcess;
    const readText = vi.fn(async (path: string) => {
      if (path.endsWith('/status')) {
        return [
          'Name:\tgezeld',
          'State:\tD (disk sleep)',
          'PPid:\t4000',
          'Threads:\t17',
          'VmRSS:\t  123456 kB',
          'VmSwap:\t2048 kB',
          'Uid:\t1000\t1000\t1000\t1000',
        ].join('\n');
      }
      return 'fuse_wait_on_page_writeback\n';
    });

    const diagnostic = await describeOwnedChildState(child, { platform: 'linux', readText });

    expect(diagnostic).toContain('pid=4242 killed=true exitCode=null signalCode=null');
    expect(diagnostic).toContain('Name=gezeld');
    expect(diagnostic).toContain('State=D (disk sleep)');
    expect(diagnostic).toContain('Threads=17');
    expect(diagnostic).toContain('VmRSS=123456 kB');
    expect(diagnostic).toContain('wchan=fuse_wait_on_page_writeback');
    expect(diagnostic).not.toContain('Uid=');
  });

  it('records when the process disappeared before procfs could be read', async () => {
    const child = {
      pid: 4242,
      killed: true,
      exitCode: null,
      signalCode: null,
    } as unknown as ChildProcess;
    const readText = vi.fn(async () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    });

    const diagnostic = await describeOwnedChildState(child, { platform: 'linux', readText });

    expect(diagnostic).toContain('procStatus=unavailable(Error [ENOENT]: no such file)');
  });
});
