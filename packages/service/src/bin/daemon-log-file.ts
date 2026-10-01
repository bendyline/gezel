import { REDACTED } from '@bendyline/gezel';
import { gezelHome, gezelPaths } from '@bendyline/gezel/paths';
import { LlamaCppLogFile as RollingLogFile } from '../providers/llama-cpp/log.js';

/** A stopping daemon waits this long, at most, for queued lines to reach disk. */
const FLUSH_BUDGET_MS = 2_000;

/**
 * `?token=` / `&token=` values, such as the one-time web UI URL gezeld prints
 * in `--web` mode. `redactCredentials` (applied by the writer) covers token
 * shapes, not query parameters, and a log file is what people attach to bug
 * reports.
 */
const QUERY_TOKEN = /([?&]token=)[^\s&#]+/gi;

type TeeableStream = Pick<NodeJS.WritableStream, 'write'>;

export interface DaemonLogFile {
  /** Wait, within a short budget, for queued lines to reach disk. */
  flush(): Promise<void>;
  /** Stop mirroring and close the file. */
  close(): Promise<void>;
}

export interface DaemonLogFileOptions {
  env?: NodeJS.ProcessEnv;
  /** The streams to mirror; the process's own stdout and stderr by default. */
  streams?: TeeableStream[];
}

/**
 * Keep the daemon's own output in `<home>/logs/service-YYYY-MM-DD.log` when
 * the host that started it cannot. Daemons the CLI, the app SDK and the VS
 * Code extension start run with their output discarded, so nothing they
 * printed survived anywhere (2026-09-30 npm ship audit). Those spawners set
 * `GEZEL_DAEMON_LOG_FILE=1` (discover-or-spawn.ts); the Electron supervisor
 * persists the piped output itself and never sets it.
 *
 * Same file name, 10 MB roll and 7-day retention as the supervisor's
 * rotator, with credential shapes redacted on the way to disk.
 */
export function installDaemonLogFile(options: DaemonLogFileOptions = {}): DaemonLogFile | null {
  const env = options.env ?? process.env;
  if (env.GEZEL_DAEMON_LOG_FILE !== '1') return null;
  const file = new RollingLogFile(gezelPaths(gezelHome(env)).logs, 'service');
  const restores = (options.streams ?? [process.stdout, process.stderr]).map((stream) =>
    teeInto(stream, file),
  );
  const flush = async () => {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FLUSH_BUDGET_MS);
      timer.unref();
    });
    try {
      await Promise.race([file.flush().catch(() => undefined), budget]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    flush,
    close: async () => {
      for (const restore of restores) restore();
      await flush();
      await file.close();
    },
  };
}

function teeInto(stream: TeeableStream, file: RollingLogFile): () => void {
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
        const text = (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
          .replace(QUERY_TOKEN, `$1${REDACTED}`)
          .trimEnd();
        if (text.length > 0) file.write(text);
      }
    } catch {
      /* logging must never break the stream it mirrors */
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as TeeableStream['write'];
  return () => {
    stream.write = original;
  };
}
