import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, getLogLevel, setDebugNamespaces, setLogLevel } from './log.js';

describe('logger', () => {
  const initialLevel = getLogLevel();

  afterEach(() => {
    setLogLevel(initialLevel);
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
});
