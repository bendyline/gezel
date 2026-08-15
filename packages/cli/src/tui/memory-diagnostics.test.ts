import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEventEnvelope, TerminalEventEnvelope } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRetainedPerformanceMeasures,
  startTuiRuntimeDiagnostics,
} from './memory-diagnostics.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('TUI memory diagnostics', () => {
  it('clears a retained performance timeline only above the limit', () => {
    const clearMeasures = vi.fn();
    const timeline = {
      getEntriesByType: vi.fn(() => [{}, {}, {}]),
      clearMeasures,
    };

    expect(clearRetainedPerformanceMeasures(timeline, 2)).toBe(3);
    expect(clearMeasures).toHaveBeenCalledOnce();
    clearMeasures.mockClear();
    expect(clearRetainedPerformanceMeasures(timeline, 3)).toBe(0);
    expect(clearMeasures).not.toHaveBeenCalled();
  });

  it('persists numeric event pressure without logging streamed content', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-tui-memory-'));
    homes.push(home);
    const diagnostics = startTuiRuntimeDiagnostics({
      home,
      intervalMs: 60_000,
      pressureHeapBytes: Number.MAX_SAFE_INTEGER,
      growthLogBytes: Number.MAX_SAFE_INTEGER,
      timeline: { getEntriesByType: () => [], clearMeasures: () => undefined },
    });
    const secret = 'content-that-must-not-enter-diagnostics';
    diagnostics.recordChatEvent({
      sessionId: 'session-1',
      gezelId: 'builder',
      projectId: 'studio',
      event: { type: 'delta', content: secret },
    } satisfies ChatEventEnvelope);
    diagnostics.recordTerminalEvent({
      projectId: 'studio',
      threadId: 'terminal-1',
      kind: 'outputChunk',
      runId: 'run-1',
      chunk: secret,
    } satisfies TerminalEventEnvelope);
    diagnostics.recordReactCommit();
    await diagnostics.stop();

    const files = await readdir(join(home, 'logs'));
    expect(files).toHaveLength(1);
    const log = await readFile(join(home, 'logs', files[0] as string), 'utf8');
    const records = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records.at(-1)).toMatchObject({
      type: 'tui.memory',
      phase: 'shutdown',
      counters: {
        chatEvents: 1,
        streamFragments: 1,
        streamChars: secret.length,
        terminalEvents: 1,
        terminalChunks: 1,
        terminalChars: secret.length,
        reactCommits: 1,
      },
      eventTypes: { delta: 1 },
    });
    expect(log).not.toContain(secret);
  });
});
