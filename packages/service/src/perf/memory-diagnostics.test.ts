/** Memory pressure should retain useful operation context without flooding logs. */
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ used: 100, log: vi.fn() }));
vi.mock('node:v8', () => ({ getHeapStatistics: () => ({ heap_size_limit: 1000 }) }));
vi.mock('@bendyline/gezel', () => ({ createLogger: () => ({ info: state.log }) }));
vi.mock('./responsiveness.js', () => ({
  perfSnapshot: () => ({
    inflight: Array.from({ length: 20 }, () => ({ label: 'growth signals', durationMs: 100 })),
  }),
}));
import { startMemoryDiagnostics } from './memory-diagnostics.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  state.log.mockClear();
});
it('logs each minute, accelerates under pressure, caps context and stops cleanly', async () => {
  vi.stubEnv('GEZEL_MEMORY_DIAGNOSTICS', '1');
  vi.useFakeTimers();
  vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
    rss: 1200,
    heapUsed: state.used,
    heapTotal: 1000,
    external: 0,
    arrayBuffers: 0,
  }));
  const stop = startMemoryDiagnostics();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.log).toHaveBeenCalledTimes(2);
  state.used = 800;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(state.log).toHaveBeenCalledTimes(4);
  const sample = JSON.parse(state.log.mock.calls.at(-1)![0]);
  expect(sample).toMatchObject({ pid: process.pid, pressure: true, activeOperations: 20 });
  expect(sample.work).toHaveLength(8);
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.log).toHaveBeenCalledTimes(4);
});
it('stays silent unless explicitly enabled', () => {
  vi.stubEnv('GEZEL_MEMORY_DIAGNOSTICS', '0');
  startMemoryDiagnostics()();
  expect(state.log).not.toHaveBeenCalled();
});
