/**
 * Process-wide structured logger. One namespaced instance per subsystem
 * (`createLogger('chat')`, `createLogger('mcp-bridge')`, …) so output
 * stays greppable and levels can be tuned without rewiring callers.
 *
 * The level gate is read from `GEZEL_LOG_LEVEL` at module load. Tests
 * may override at runtime via `setLogLevel`. A null `GEZEL_LOG_LEVEL`
 * defaults to `info` — debug noise stays off in packaged builds and CI
 * unless a developer explicitly opts in.
 *
 * Per-namespace debug is available via `GEZEL_LOG_DEBUG` as a
 * comma-separated allow-list (`GEZEL_LOG_DEBUG=chat,mcp-bridge`). A
 * single `*` enables debug everywhere.
 *
 * Output goes to `stderr` for `warn`/`error`, `stdout` for `info`/`debug`,
 * matching Node's defaults so log aggregators that split streams keep
 * working.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  readonly name: string;
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  child(suffix: string): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const LEVEL_LABEL: Record<Exclude<LogLevel, 'silent'>, string> = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'INFO ',
  debug: 'DEBUG',
};

function parseLevel(raw: string | undefined): LogLevel | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return null;
  if (normalized in LEVEL_ORDER) return normalized as LogLevel;
  return null;
}

function parseNamespaceAllowList(raw: string | undefined): Set<string> | '*' | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed === '*') return '*';
  return new Set(
    trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

let currentLevel: LogLevel = parseLevel(process.env.GEZEL_LOG_LEVEL) ?? 'info';
let debugAllow: Set<string> | '*' | null = parseNamespaceAllowList(process.env.GEZEL_LOG_DEBUG);

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Override the per-namespace debug allow-list. Pass `null` to clear.
 * Mainly used by tests; production callers set `GEZEL_LOG_DEBUG`.
 */
export function setDebugNamespaces(spec: string | null): void {
  debugAllow = parseNamespaceAllowList(spec ?? undefined);
}

function shouldEmit(level: Exclude<LogLevel, 'silent'>, name: string): boolean {
  if (level === 'debug') {
    if (debugAllow === '*') return true;
    if (debugAllow?.has(name)) return true;
  }
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

function format(level: Exclude<LogLevel, 'silent'>, name: string, message: string): string {
  return `${new Date().toISOString()} ${LEVEL_LABEL[level]} [${name}] ${message}`;
}

/**
 * A launcher is allowed to close a pipe before Gezel does. In that case the
 * next write can either throw synchronously (notably EBADF on Windows) or emit
 * an asynchronous `error` event (usually EPIPE on Unix). Neither is an
 * application failure: there is simply nowhere left to display the log line.
 */
export function isClosedProcessOutputError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'EPIPE' || code === 'EBADF';
}

type ProcessOutputStream = {
  write(chunk: string | Uint8Array): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
};

const guardedProcessOutputStreams = new WeakSet<object>();

/**
 * Install the asynchronous half of broken-pipe protection once per stream.
 * Unexpected stream errors still throw: only the two errors that mean the
 * consumer deliberately disappeared are downgraded to a dropped log line.
 */
export function guardProcessOutputStream(stream: ProcessOutputStream): void {
  if (guardedProcessOutputStreams.has(stream)) return;
  guardedProcessOutputStreams.add(stream);
  stream.on('error', (error) => {
    if (!isClosedProcessOutputError(error)) throw error;
  });
}

/** Write process output without turning a closed stdout/stderr pipe into a crash. */
export function writeProcessOutput(
  stream: ProcessOutputStream,
  chunk: string | Uint8Array,
): boolean {
  guardProcessOutputStream(stream);
  try {
    return stream.write(chunk);
  } catch (error) {
    if (isClosedProcessOutputError(error)) return false;
    throw error;
  }
}

function emit(
  level: Exclude<LogLevel, 'silent'>,
  name: string,
  message: string,
  rest: unknown[],
): void {
  if (!shouldEmit(level, name)) return;
  const line = format(level, name, message);
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  if (rest.length === 0) {
    writeProcessOutput(stream, `${line}\n`);
    return;
  }
  // Defer formatting of `rest` to console.* so Node's util.inspect handles
  // objects/errors uniformly. Write the prefix line first to keep ordering
  // tight when the stream is line-buffered.
  writeProcessOutput(stream, `${line}\n`);
  const sink = level === 'warn' || level === 'error' ? console.error : console.log;
  sink(...rest);
}

export function createLogger(name: string): Logger {
  return {
    name,
    debug(message, ...rest) {
      emit('debug', name, message, rest);
    },
    info(message, ...rest) {
      emit('info', name, message, rest);
    },
    warn(message, ...rest) {
      emit('warn', name, message, rest);
    },
    error(message, ...rest) {
      emit('error', name, message, rest);
    },
    child(suffix) {
      return createLogger(`${name}:${suffix}`);
    },
  };
}
