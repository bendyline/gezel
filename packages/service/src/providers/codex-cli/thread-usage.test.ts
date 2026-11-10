import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexThreadTotal, turnUsageFromThreadTotal } from './thread-usage.js';

const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
  model: 'gpt-6.1-sol',
  inputTokens,
  cachedInputTokens,
  outputTokens,
  durationMs: 10,
  at: '2026-11-10T00:00:00.000Z',
});

describe('turnUsageFromThreadTotal', () => {
  it('charges each resumed turn only what the thread added since the last one', () => {
    let total = null;
    const charged: number[] = [];
    for (const running of [60_578, 132_392, 230_389]) {
      const turn = turnUsageFromThreadTotal(
        usage(running, running - 10_000, 100),
        'thread-a',
        total,
      );
      charged.push(turn.usage.inputTokens);
      total = turn.total;
    }
    expect(charged).toEqual([60_578, 71_814, 97_997]);
    expect(charged.reduce((a, b) => a + b, 0)).toBe(230_389);
  });

  it('subtracts cached input and output too, and drops a cached figure of zero', () => {
    const first = turnUsageFromThreadTotal(usage(100, 40, 10), 't', null);
    const second = turnUsageFromThreadTotal(usage(250, 40, 25), 't', first.total);
    expect(second.usage).toMatchObject({ inputTokens: 150, outputTokens: 15 });
    expect(second.usage.cachedInputTokens).toBeUndefined();
  });

  it('charges the reported figures for a new thread or a total that went down', () => {
    const prior = { threadId: 'old', inputTokens: 500, cachedInputTokens: 0, outputTokens: 50 };
    expect(turnUsageFromThreadTotal(usage(120, 0, 5), 'new', prior).usage.inputTokens).toBe(120);
    const reset = { threadId: 'new', inputTokens: 500, cachedInputTokens: 0, outputTokens: 50 };
    expect(turnUsageFromThreadTotal(usage(120, 0, 5), 'new', reset).usage.inputTokens).toBe(120);
    expect(turnUsageFromThreadTotal(usage(120, 0, 5), null, reset)).toEqual({
      usage: usage(120, 0, 5),
      total: null,
    });
  });
});

describe('readCodexThreadTotal', () => {
  let home: string | undefined;
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("reads the last running total from the thread's rollout", async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-codex-thread-'));
    const dir = join(home, 'sessions/2026/11/10');
    await mkdir(dir, { recursive: true });
    const count = (input: number, cached: number, output: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
            },
          },
        },
      });
    await writeFile(
      join(dir, 'rollout-2026-11-10T05-12-54-thread-b.jsonl'),
      [
        count(60, 10, 5),
        '{"type":"event_msg","payload":{"type":"token_count","info":null}}',
        count(130, 70, 9),
        'oops',
      ].join('\n'),
    );
    await writeFile(join(dir, 'rollout-2026-11-10T05-12-54-thread-c.jsonl'), count(999, 0, 1));
    expect(await readCodexThreadTotal(home, 'thread-b')).toEqual({
      threadId: 'thread-b',
      inputTokens: 130,
      cachedInputTokens: 70,
      outputTokens: 9,
    });
    expect(await readCodexThreadTotal(home, 'thread-x')).toBeNull();
    expect(await readCodexThreadTotal(join(home, 'missing'), 'thread-b')).toBeNull();
  });
});
