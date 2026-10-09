/**
 * Opt-in aggregate memory diagnostics for unattended service workloads.
 * Logs sizes and active operation labels each minute, or every ten seconds
 * above 75% of the V8 limit. PID/uptime distinguish restarts and overlapping
 * processes. Uses the responsiveness monitor's bounded, sanitized labels;
 * no task contents, heap snapshots or debugger endpoint are collected.
 */
import { getHeapStatistics } from 'node:v8';
import { createLogger } from '@bendyline/gezel';
import { perfSnapshot } from './responsiveness.js';

const log = createLogger('memory-diagnostics');

export function startMemoryDiagnostics(): () => void {
  if (process.env.GEZEL_MEMORY_DIAGNOSTICS !== '1') return () => {};
  let lastReport = Number.NEGATIVE_INFINITY;
  const report = () => {
    const memory = process.memoryUsage();
    const limit = getHeapStatistics().heap_size_limit;
    const pressure = memory.heapUsed >= limit * 0.75;
    const now = Date.now();
    if (!pressure && now - lastReport < 60_000) return;
    lastReport = now;
    const mib = (bytes: number) => Math.round(bytes / 1024 / 1024);
    const work = perfSnapshot().inflight;
    log.info(
      JSON.stringify({
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        rssMiB: mib(memory.rss),
        heapUsedMiB: mib(memory.heapUsed),
        heapTotalMiB: mib(memory.heapTotal),
        heapLimitMiB: mib(limit),
        externalMiB: mib(memory.external),
        pressure,
        activeOperations: work.length,
        work: work.slice(0, 8),
      }),
    );
  };
  report();
  const timer = setInterval(report, 10_000);
  timer.unref();
  return () => clearInterval(timer);
}
