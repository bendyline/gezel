import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import type { ChatEventEnvelope, TerminalEventEnvelope } from '@bendyline/gezel';
import { gezelHome, gezelPaths } from '@bendyline/gezel/paths';

const DEFAULT_SAMPLE_INTERVAL_MS = 15_000;
const DEFAULT_MEASURE_LIMIT = 2_000;
const DEFAULT_PRESSURE_HEAP_BYTES = 256 * 1024 * 1024;
const DEFAULT_GROWTH_LOG_BYTES = 64 * 1024 * 1024;
const COMMIT_CLEANUP_INTERVAL = 250;

interface PerformanceTimeline {
  getEntriesByType(type: string): ReadonlyArray<unknown>;
  clearMeasures(): void;
}

export interface TuiRuntimeDiagnostics {
  recordChatEvent(env: ChatEventEnvelope): void;
  recordTerminalEvent(env: TerminalEventEnvelope): void;
  recordReactCommit(): void;
  stop(): Promise<void>;
}

export interface TuiRuntimeDiagnosticsOptions {
  home?: string;
  intervalMs?: number;
  performanceMeasureLimit?: number;
  pressureHeapBytes?: number;
  growthLogBytes?: number;
  alwaysLog?: boolean;
  timeline?: PerformanceTimeline;
}

/**
 * Clear an unexpectedly large retained Performance Timeline. React's
 * development reconciler records component measures in Node and does not
 * clear them; that can retain gigabytes over a long streaming TUI session.
 * Production React does not create these entries, so any cleanup is also a
 * useful packaging-regression signal in the diagnostics log.
 */
export function clearRetainedPerformanceMeasures(
  timeline: PerformanceTimeline = performance,
  limit = DEFAULT_MEASURE_LIMIT,
): number {
  const count = timeline.getEntriesByType('measure').length;
  if (count <= limit) return 0;
  timeline.clearMeasures();
  return count;
}

/**
 * Record numeric-only TUI health telemetry under GEZEL_HOME/logs. Normal
 * sessions write start/stop records; interval samples become persistent only
 * under memory pressure, on material heap growth, or when explicitly enabled
 * with GEZEL_TUI_MEMORY_DIAGNOSTICS=1.
 */
export function startTuiRuntimeDiagnostics(
  options: TuiRuntimeDiagnosticsOptions = {},
): TuiRuntimeDiagnostics {
  const home = options.home ?? gezelHome();
  const logsDir = gezelPaths(home).logs;
  const timeline = options.timeline ?? performance;
  const measureLimit = options.performanceMeasureLimit ?? DEFAULT_MEASURE_LIMIT;
  const pressureHeapBytes = options.pressureHeapBytes ?? DEFAULT_PRESSURE_HEAP_BYTES;
  const growthLogBytes = options.growthLogBytes ?? DEFAULT_GROWTH_LOG_BYTES;
  const alwaysLog = options.alwaysLog ?? process.env.GEZEL_TUI_MEMORY_DIAGNOSTICS?.trim() === '1';
  const eventTypes: Record<string, number> = {};
  const counters = {
    chatEvents: 0,
    streamFragments: 0,
    streamChars: 0,
    terminalEvents: 0,
    terminalChunks: 0,
    terminalChars: 0,
    reactCommits: 0,
  };
  let stopped = false;
  let lastLoggedHeapUsed = 0;
  let peakHeapUsed = 0;
  let peakRss = 0;
  let writeChain = Promise.resolve();

  const sample = (
    phase: 'startup' | 'interval' | 'performance_cleanup' | 'shutdown',
    force = false,
    measuresCleared = 0,
  ): void => {
    const memory = process.memoryUsage();
    const heap = getHeapStatistics();
    peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);

    const performanceMeasures = timeline.getEntriesByType('measure').length;
    const cleared = measuresCleared || clearRetainedPerformanceMeasures(timeline, measureLimit);
    const shouldWrite =
      force ||
      alwaysLog ||
      cleared > 0 ||
      memory.heapUsed >= pressureHeapBytes ||
      memory.heapUsed - lastLoggedHeapUsed >= growthLogBytes;
    if (!shouldWrite) return;
    lastLoggedHeapUsed = memory.heapUsed;

    const at = new Date().toISOString();
    const record = {
      type: 'tui.memory',
      version: 1,
      at,
      phase,
      pid: process.pid,
      nodeEnv: process.env.NODE_ENV ?? null,
      nodeVersion: process.version,
      uptimeMs: Math.round(process.uptime() * 1_000),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        peakHeapUsed,
        peakRss,
        heapSizeLimit: heap.heap_size_limit,
        totalAvailableSize: heap.total_available_size,
        mallocedMemory: heap.malloced_memory,
        peakMallocedMemory: heap.peak_malloced_memory,
        nativeContexts: heap.number_of_native_contexts,
        detachedContexts: heap.number_of_detached_contexts,
      },
      activeResources: countActiveResources(),
      performanceMeasures,
      measuresCleared: cleared,
      counters: { ...counters },
      eventTypes: { ...eventTypes },
    };
    const file = join(logsDir, `tui-memory-${at.slice(0, 10)}.jsonl`);
    writeChain = writeChain
      .then(async () => {
        await mkdir(logsDir, { recursive: true });
        await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
      })
      // Diagnostics must never destabilize or paint over the interactive UI.
      .catch(() => undefined);
  };

  sample('startup', true);
  const interval = setInterval(
    () => sample('interval'),
    options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
  );
  interval.unref();

  return {
    recordChatEvent(env) {
      counters.chatEvents += 1;
      eventTypes[env.event.type] = (eventTypes[env.event.type] ?? 0) + 1;
      if (
        env.event.type === 'delta' ||
        env.event.type === 'reasoning_delta' ||
        env.event.type === 'tool_args_delta'
      ) {
        counters.streamFragments += 1;
        counters.streamChars += env.event.content.length;
      }
    },
    recordTerminalEvent(env) {
      counters.terminalEvents += 1;
      if (env.kind === 'outputChunk') {
        counters.terminalChunks += 1;
        counters.terminalChars += env.chunk.length;
      }
    },
    recordReactCommit() {
      counters.reactCommits += 1;
      if (counters.reactCommits % COMMIT_CLEANUP_INTERVAL !== 0) return;
      const cleared = clearRetainedPerformanceMeasures(timeline, measureLimit);
      if (cleared > 0) sample('performance_cleanup', true, cleared);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      sample('shutdown', true);
      await writeChain;
    },
  };
}

function countActiveResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const resource of process.getActiveResourcesInfo()) {
    counts[resource] = (counts[resource] ?? 0) + 1;
  }
  return counts;
}
