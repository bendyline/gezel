/**
 * Opt-in aggregate memory diagnostics for unattended service workloads.
 * Logs process and V8 heap sizes once a minute so a crash can be distinguished
 * from a request timeout. Records no task text, credentials or heap contents;
 * no debugger or listening socket is opened. The service owns timer cleanup.
 */
import { getHeapStatistics } from 'node:v8';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('memory-diagnostics');

export function startMemoryDiagnostics(): () => void {
  if (process.env.GEZEL_MEMORY_DIAGNOSTICS !== '1') return () => {};
  const report = () => {
    const memory = process.memoryUsage();
    const mib = (bytes: number) => Math.round(bytes / 1024 / 1024);
    log.info(JSON.stringify({ rssMiB: mib(memory.rss), heapUsedMiB: mib(memory.heapUsed),
      heapLimitMiB: mib(getHeapStatistics().heap_size_limit), externalMiB: mib(memory.external) }));
  };
  report();
  const timer = setInterval(report, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
