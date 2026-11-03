import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it } from 'vitest';
import { parseMlxPrefillTelemetry, readMlxPrefillTelemetry } from './mlx-prefill-telemetry.ts';
import { PerfCollector } from './perf-collector.ts';

const line = (event: object, rx = '2026-11-03T07:00:00Z') =>
  JSON.stringify({
    rx,
    sessionId: 's1',
    event: { provider: 'mlx', ...event },
  });
const first = {
  type: 'engine_phase',
  phase: 'generating',
  detail: 'First token in 19.5s · prefill 819 tok/s',
  ttftMs: 19474,
};

describe('MLX recorded prefill telemetry', () => {
  it('recovers rounded first-token diagnostics without treating TTFT as prefill duration', () => {
    const parsed = parseMlxPrefillTelemetry(
      [
        line(first),
        line(first),
        line(first, 'later'),
        line({ ...first, detail: 'First token in 1.1s · prefill 1001 tok/s' }, 'last'),
      ].join('\n'),
    );
    expect(parsed).toMatchObject({
      tokensPerSec: 819,
      source: 'first-token-detail',
      sampleCount: 3,
      duplicateLineCount: 1,
    });
    expect(parsed.observations[0]).toMatchObject({ line: 1, sessionId: 's1', ttftMs: 19474 });
    expect(parsed).not.toHaveProperty('promptMs');
  });

  it('prefers precise structured terminal rates without mixing first-token request boundaries', () => {
    const parsed = parseMlxPrefillTelemetry(
      [
        line(first),
        line({ type: 'turn_stats', promptTokensPerSec: 400.25, cachedPromptTokens: 0, ttftMs: 0 }),
        line({ type: 'turn_stats', promptTokensPerSec: 600.75 }, 'later'),
      ].join('\n'),
    );
    expect(parsed).toMatchObject({
      tokensPerSec: 500.5,
      source: 'turn_stats',
      sampleCount: 2,
      firstTokenSampleCount: 1,
      structuredSampleCount: 2,
    });
    expect(parsed.observations[1]).toMatchObject({ cachedPromptTokens: 0, ttftMs: 0 });
  });

  it('keeps missing/invalid measurements unknown and never reads generated prose as telemetry', () => {
    const parsed = parseMlxPrefillTelemetry(
      [
        '{truncated',
        'null',
        '[]',
        '',
        line({ ...first, provider: 'llama-cpp' }),
        line({ ...first, type: 'delta' }),
        line({ ...first, phase: 'prefill' }),
        ...[undefined, 0, -1, '123', null].map((rate) =>
          line({ type: 'turn_stats', promptTokensPerSec: rate }),
        ),
      ].join('\n'),
    );
    expect(parsed).toMatchObject({
      tokensPerSec: null,
      source: null,
      sampleCount: 0,
      malformedLineCount: 1,
    });
  });

  it('collects flushed event rates even without an MLX log pulse; keeps aggregate timing unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mlx-prefill-'));
    const path = join(dir, 'events.jsonl');
    try {
      const jsonl = line({
        type: 'turn_stats',
        promptTokensPerSec: 1234.5,
        cachedPromptTokens: 10,
      });
      await writeFile(path, jsonl);
      expect(await readMlxPrefillTelemetry(path)).toEqual(parseMlxPrefillTelemetry(jsonl));
      const collector = new PerfCollector({
        log: () => {},
        enableLocalSampling: false,
        client: { getUsage: async () => ({ providers: {} }) } as unknown as GezelClient,
        chatEventsPath: path,
      });
      const metrics = await collector.stop();
      expect(metrics.mlxPrefill).toMatchObject({
        tokensPerSec: 1234.5,
        sampleCount: 1,
        source: 'turn_stats',
      });
      expect(metrics.derived.promptTokensPerSec).toBeNull();
      const missing = new PerfCollector({
        log: () => {},
        enableLocalSampling: false,
        client: { getUsage: async () => ({ providers: {} }) } as unknown as GezelClient,
        chatEventsPath: join(dir, 'missing'),
      });
      expect((await missing.stop()).mlxPrefill).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
