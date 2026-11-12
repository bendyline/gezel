import {
  type LogOutput,
  getLogOutput,
  getLogSink,
  setLogOutput,
  setLogSink,
  writeProcessOutput,
} from '@bendyline/gezel';
import { LlamaCppLogFile as RollingLogFile } from '@bendyline/gezel-inference/internal/providers/llama-cpp/log';
import { gezelPaths } from '@bendyline/gezel/paths';

export type ServiceLogOutput = LogOutput | 'file';

/** A stopping service waits this long, at most, for queued lines to reach disk. */
const FLUSH_BUDGET_MS = 2_000;

/**
 * Route log records for one hosted service's lifetime. The returned function
 * restores the routing the process had before, after flushing the file when
 * there is one.
 *
 * `'file'` writes to the same rolling `service-YYYY-MM-DD.log` a CLI-spawned
 * daemon keeps (bin/daemon-log-file.ts), so a command that ran the service in
 * its own process leaves the same record behind without printing it: a first
 * `gezel run` showed `WARN [tasks] default/1 runs stepwise: …` above its reply
 * (2026-11-11 npm ship audit). Errors still reach stderr.
 */
export function routeServiceLogs(output: ServiceLogOutput, home: string): () => Promise<void> {
  const previousOutput = getLogOutput();
  const previousSink = getLogSink();
  if (output !== 'file') {
    setLogOutput(output);
    return async () => {
      setLogOutput(previousOutput);
    };
  }
  const file = new RollingLogFile(gezelPaths(home).logs, 'service');
  setLogOutput('stderr');
  setLogSink((record) => {
    file.write(record.line);
    if (record.level === 'error') writeProcessOutput(process.stderr, `${record.line}\n`);
  });
  let restored: Promise<void> | undefined;
  return () => {
    restored ??= (async () => {
      setLogSink(previousSink);
      setLogOutput(previousOutput);
      await withinBudget(file.close());
    })();
    return restored;
  };
}

async function withinBudget(work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_BUDGET_MS);
    timer.unref();
  });
  try {
    await Promise.race([work.catch(() => undefined), budget]);
  } finally {
    clearTimeout(timer);
  }
}
