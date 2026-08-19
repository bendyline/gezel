import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  getLogLevel,
  getLogOutput,
  guardProcessOutputStream,
  setDebugNamespaces,
  setLogLevel,
  setLogOutput,
} from './log.js';

describe('logger', () => {
  const initialLevel = getLogLevel();
  const initialOutput = getLogOutput();

  afterEach(() => {
    setLogLevel(initialLevel);
    setLogOutput(initialOutput);
    setDebugNamespaces(null);
    vi.restoreAllMocks();
  });

  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write);
    return {
      lines,
      restore: () => {
        spy.mockRestore();
        // touch original to ensure tsc doesn't drop the rebind
        void original;
      },
    };
  }

  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write);
    return { lines, restore: () => spy.mockRestore() };
  }

  it('defaults to info — emits info/warn/error, drops debug', () => {
    setLogLevel('info');
    const out = captureStdout();
    const err = captureStderr();
    const log = createLogger('test');
    log.debug('dropped');
    log.info('hello');
    log.warn('uh oh');
    log.error('boom');
    out.restore();
    err.restore();
    expect(out.lines.some((l) => l.includes('dropped'))).toBe(false);
    expect(out.lines.some((l) => l.includes('INFO  [test] hello'))).toBe(true);
    expect(err.lines.some((l) => l.includes('WARN  [test] uh oh'))).toBe(true);
    expect(err.lines.some((l) => l.includes('ERROR [test] boom'))).toBe(true);
  });

  it('silent drops everything', () => {
    setLogLevel('silent');
    const out = captureStdout();
    const err = captureStderr();
    const log = createLogger('test');
    log.error('still gone');
    log.warn('also gone');
    log.info('gone');
    log.debug('gone');
    out.restore();
    err.restore();
    expect(out.lines).toEqual([]);
    expect(err.lines).toEqual([]);
  });

  it('debug level emits everything', () => {
    setLogLevel('debug');
    const out = captureStdout();
    captureStderr();
    createLogger('test').debug('seen');
    expect(out.lines.some((l) => l.includes('DEBUG [test] seen'))).toBe(true);
  });

  it('can route info and debug records to stderr for result-only commands', () => {
    setLogLevel('debug');
    setLogOutput('stderr');
    const out = captureStdout();
    const err = captureStderr();
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('result-command');

    log.info('booting');
    log.debug('details', { phase: 'setup' });

    expect(out.lines).toEqual([]);
    expect(err.lines.some((line) => line.includes('INFO  [result-command] booting'))).toBe(true);
    expect(err.lines.some((line) => line.includes('DEBUG [result-command] details'))).toBe(true);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith({ phase: 'setup' });
  });

  it('per-namespace debug works at info level', () => {
    setLogLevel('info');
    setDebugNamespaces('chat,mcp-bridge');
    const out = captureStdout();
    createLogger('chat').debug('chat-msg');
    createLogger('mcp-bridge').debug('mcp-msg');
    createLogger('other').debug('dropped');
    expect(out.lines.some((l) => l.includes('DEBUG [chat] chat-msg'))).toBe(true);
    expect(out.lines.some((l) => l.includes('DEBUG [mcp-bridge] mcp-msg'))).toBe(true);
    expect(out.lines.some((l) => l.includes('dropped'))).toBe(false);
  });

  it('GEZEL_LOG_DEBUG=* enables debug everywhere even at info', () => {
    setLogLevel('info');
    setDebugNamespaces('*');
    const out = captureStdout();
    createLogger('anything').debug('seen');
    expect(out.lines.some((l) => l.includes('DEBUG [anything] seen'))).toBe(true);
  });

  it('child loggers concatenate names with a colon', () => {
    setLogLevel('info');
    const out = captureStdout();
    const log = createLogger('chat').child('runSend');
    log.info('hi');
    expect(log.name).toBe('chat:runSend');
    expect(out.lines.some((l) => l.includes('[chat:runSend] hi'))).toBe(true);
  });

  it('extra args are forwarded to console.* for util.inspect handling', () => {
    setLogLevel('info');
    const out = captureStdout();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('test').info('with object', { a: 1 });
    expect(out.lines.some((l) => l.includes('INFO  [test] with object'))).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith({ a: 1 });
  });

  it.each(['EPIPE', 'EBADF'])('drops a log line when stdout throws %s', (code) => {
    setLogLevel('info');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw Object.assign(new Error(`write ${code}`), { code });
    });
    expect(() => createLogger('test').info('consumer went away')).not.toThrow();
  });

  it('does not hide unexpected synchronous stream failures', () => {
    setLogLevel('info');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw Object.assign(new Error('write EIO'), { code: 'EIO' });
    });
    expect(() => createLogger('test').info('disk-like failure')).toThrow('write EIO');
  });

  it('drops asynchronous EPIPE/EBADF events but rethrows unexpected stream errors', () => {
    let onError: ((error: Error) => void) | undefined;
    const stream = {
      write: () => true,
      on: (_event: 'error', listener: (error: Error) => void) => {
        onError = listener;
      },
    };
    guardProcessOutputStream(stream);

    expect(() =>
      onError?.(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })),
    ).not.toThrow();
    expect(() => onError?.(Object.assign(new Error('bad fd'), { code: 'EBADF' }))).not.toThrow();
    expect(() => onError?.(Object.assign(new Error('I/O failure'), { code: 'EIO' }))).toThrow(
      'I/O failure',
    );
  });
});
