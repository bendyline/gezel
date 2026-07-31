import { describe, expect, it } from 'vitest';
import {
  extractBilling,
  parseDs4Timings,
  parseLlamaCppTimings,
  parseMlxTimings,
  sumProcessTree,
  sumProviderTokens,
  winCpuPercent,
} from './perf-collector.ts';

describe('extractBilling', () => {
  it('returns null when no provider data is present', () => {
    expect(extractBilling(null)).toBeNull();
    expect(extractBilling({})).toBeNull();
    expect(extractBilling({ copilot: null })).toBeNull();
  });

  it('returns null when no provider has any activity (boot-then-fail trials)', () => {
    expect(
      extractBilling({
        copilot: { totalTurns: 0, totalTokensIn: 0, quotaBuckets: [] },
      }),
    ).toBeNull();
  });

  it('extracts Copilot premium-interactions quota (the load-bearing metering surface)', () => {
    // Real shape from a copilot trial. The `chat` and
    // `completions` buckets are unlimited and must be filtered out;
    // `premium_interactions` is the bucket that actually costs money.
    const billing = extractBilling({
      copilot: {
        quotaBuckets: [
          {
            name: 'premium_interactions',
            isUnlimited: false,
            limit: 1500,
            used: 945,
            remaining: 555,
            remainingPercent: 37,
            overage: 0,
            resetDate: '2026-06-01T00:00:00.000Z',
          },
          { name: 'chat', isUnlimited: true, limit: -1, used: 0, remainingPercent: 100 },
          { name: 'completions', isUnlimited: true, limit: -1, used: 0, remainingPercent: 100 },
        ],
        totalTurns: 6,
        totalTokensIn: 164074,
        totalTokensOut: 3511,
        totalCost: 0,
      },
    });

    expect(billing).not.toBeNull();
    expect(billing!.provider).toBe('copilot');
    expect(billing!.limitedQuota).toEqual([
      {
        name: 'premium_interactions',
        used: 945,
        limit: 1500,
        remainingPercent: 37,
        resetDate: '2026-06-01T00:00:00.000Z',
      },
    ]);
  });

  it('still surfaces tokens for Copilot even when the cost surface is the quota', () => {
    // Copilot reports tokens but doesn't bill on them. The postmortem
    // template should render BOTH the quota AND the tokens — the
    // tokens are an interesting "size of the conversation" signal
    // even when they aren't the billing surface.
    const billing = extractBilling({
      copilot: {
        quotaBuckets: [],
        totalTurns: 3,
        totalTokensIn: 100_000,
        totalTokensOut: 5_000,
      },
    });
    expect(billing!.tokens).toEqual({ input: 100_000, output: 5_000 });
  });

  it('extracts token billing for codex-cli (no quota, tokens-only)', () => {
    const billing = extractBilling({
      'codex-cli': {
        quotaBuckets: [],
        totalTurns: 7,
        totalTokensIn: 349_425,
        totalTokensOut: 2_667,
        totalCost: 0,
      },
    });
    expect(billing!.provider).toBe('codex-cli');
    expect(billing!.limitedQuota).toEqual([]);
    expect(billing!.tokens).toEqual({ input: 349_425, output: 2_667 });
  });

  it('surfaces totalCost when the provider reports a non-zero value', () => {
    const billing = extractBilling({
      openai: {
        quotaBuckets: [],
        totalTurns: 1,
        totalTokensIn: 100,
        totalTokensOut: 50,
        totalCost: 0.0042,
      },
    });
    expect(billing!.tokens).toEqual({ input: 100, output: 50, costUsd: 0.0042 });
  });

  it('omits costUsd when zero (avoids "0.00 USD" noise in postmortems)', () => {
    const billing = extractBilling({
      codex: {
        quotaBuckets: [],
        totalTurns: 1,
        totalTokensIn: 100,
        totalTokensOut: 50,
        totalCost: 0,
      },
    });
    expect(billing!.tokens).not.toHaveProperty('costUsd');
  });

  it('handles malformed quota bucket entries without throwing', () => {
    const billing = extractBilling({
      copilot: {
        quotaBuckets: [
          null,
          { name: 'incomplete' /* no used/limit */ },
          { name: 'good', isUnlimited: false, limit: 100, used: 42, remainingPercent: 58 },
        ],
        totalTurns: 1,
        totalTokensIn: 10,
        totalTokensOut: 5,
      },
    });
    expect(billing!.limitedQuota).toEqual([
      { name: 'good', used: 42, limit: 100, remainingPercent: 58 },
    ]);
  });
});

describe('parseLlamaCppTimings', () => {
  // Verbatim from a gemma4-31b tankcombat daemon.log: three
  // request blocks, each with a `prompt eval` (prefill) and `eval`
  // (decode) line under the `[llama-server]` prefix.
  const REAL_LOG = `
2026-05-29T16:35:11.976Z INFO  [chat] [llama-server] prompt eval time =   89150.04 ms / 15210 tokens (    5.86 ms per token,   170.61 tokens per second)
2026-05-29T16:35:11.976Z INFO  [chat] [llama-server]        eval time =   13234.12 ms /   210 tokens (   63.02 ms per token,    15.87 tokens per second)
2026-05-29T16:35:11.976Z INFO  [chat] [llama-server]       total time =  102384.16 ms / 15420 tokens
2026-05-29T16:35:18.443Z INFO  [chat] [llama-server] prompt eval time =    2387.82 ms /   301 tokens (    7.93 ms per token,   126.06 tokens per second)
2026-05-29T16:35:18.443Z INFO  [chat] [llama-server]        eval time =    3997.78 ms /    64 tokens (   62.47 ms per token,    16.01 tokens per second)
2026-05-29T16:40:27.262Z INFO  [chat] [llama-server] prompt eval time =   97957.93 ms / 16489 tokens (    5.94 ms per token,   168.33 tokens per second)
2026-05-29T16:40:27.262Z INFO  [chat] [llama-server]        eval time =  210782.88 ms /  3209 tokens (   65.68 ms per token,    15.22 tokens per second)
`;

  it('aggregates prefill + decode tokens and time across all requests', () => {
    const t = parseLlamaCppTimings(REAL_LOG)!;
    expect(t).not.toBeNull();
    expect(t.requestCount).toBe(3);
    expect(t.promptTokens).toBe(15210 + 301 + 16489); // 32000
    expect(t.genTokens).toBe(210 + 64 + 3209); // 3483
    expect(t.promptMs).toBeCloseTo(89150.04 + 2387.82 + 97957.93, 1);
    expect(t.genMs).toBeCloseTo(13234.12 + 3997.78 + 210782.88, 1);
  });

  it('computes aggregate decode + prefill throughput (the headline t/s)', () => {
    const t = parseLlamaCppTimings(REAL_LOG)!;
    // decode: 3483 tokens / 228.01478 s ≈ 15.28 t/s (matches the ~15-16 t/s per-request lines)
    expect(t.genTokensPerSec).toBeCloseTo(3483 / ((13234.12 + 3997.78 + 210782.88) / 1000), 1);
    expect(t.genTokensPerSec!).toBeGreaterThan(14);
    expect(t.genTokensPerSec!).toBeLessThan(17);
    // prefill is ~10x faster on this host
    expect(t.promptTokensPerSec!).toBeGreaterThan(t.genTokensPerSec!);
  });

  it('does NOT count the prefill ("prompt eval time") line as decode', () => {
    // A log with ONLY a prompt-eval line: genTokens must stay 0, and the
    // decode regex must not misfire on the "eval time" substring inside
    // "prompt eval time".
    const t = parseLlamaCppTimings(
      '[llama-server] prompt eval time = 1000.00 ms / 500 tokens ( 2.00 ms per token, 500.00 tokens per second)',
    )!;
    expect(t.promptTokens).toBe(500);
    expect(t.genTokens).toBe(0);
    expect(t.requestCount).toBe(0);
    expect(t.genTokensPerSec).toBeNull();
  });

  it('returns null when the log carries no llama.cpp timing lines', () => {
    expect(parseLlamaCppTimings('')).toBeNull();
    expect(parseLlamaCppTimings('some unrelated daemon log\nwith no timing lines\n')).toBeNull();
  });
});

describe('parseDs4Timings', () => {
  // Shape taken from a real ds4-server (DwarfStar) daemon.log: two requests,
  // each a sequence of per-chunk `prefill` lines (numerator = tokens processed
  // so far, of <total>) then per-chunk `decoding` lines (`gen=` = cumulative
  // decode tokens), with the running `avg=<rate> t/s <elapsed>s` tail.
  const REAL_LOG = `
2026-06-28T22:30:00Z INFO  [chat] [ds4-server] ds4-server: chat ctx=0..7509:7509 TOOLS prefill chunk 0/7509 (0.0%) chunk=0.00 t/s avg=0.00 t/s 0.001s
2026-06-28T22:30:26Z INFO  [chat] [ds4-server] ds4-server: chat ctx=0..7509:7509 TOOLS prefill chunk 4096/7509 (54.5%) chunk=156.26 t/s avg=156.25 t/s 26.214s
2026-06-28T22:30:48Z INFO  [chat] [ds4-server] ds4-server: chat ctx=0..7509:7509 TOOLS prefill chunk 7509/7509 (100%) chunk=155.00 t/s avg=156.00 t/s 48.13s
2026-06-28T22:31:00Z INFO  [chat] [ds4-server] ds4-server: chat ctx=7509..7559:50 gen=50 TOOLS DSML_START decoding chunk=13.00 t/s avg=13.00 t/s 3.85s
2026-06-28T22:33:35Z INFO  [chat] [ds4-server] ds4-server: chat ctx=9503..9553:50 gen=2044 TOOLS DSML_START decoding chunk=11.28 t/s avg=13.15 t/s 155.42s
2026-06-28T22:34:00Z INFO  [chat] [ds4-server] ds4-server: chat ctx=0..300:300 TOOLS prefill chunk 300/300 (100%) chunk=150.00 t/s avg=150.00 t/s 2.00s
2026-06-28T22:34:11Z INFO  [chat] [ds4-server] ds4-server: chat ctx=300..350:50 gen=128 TOOLS DSML_START decoding chunk=12.00 t/s avg=12.50 t/s 10.24s
`;

  it('banks each request at the next prefill-start and sums per-request finals', () => {
    const t = parseDs4Timings(REAL_LOG)!;
    expect(t).not.toBeNull();
    expect(t.requestCount).toBe(2);
    expect(t.promptTokens).toBe(7509 + 300); // last prefill numerator per request
    expect(t.genTokens).toBe(2044 + 128); // last cumulative `gen=` per request
    expect(t.promptMs).toBeCloseTo((48.13 + 2.0) * 1000, 0);
    expect(t.genMs).toBeCloseTo((155.42 + 10.24) * 1000, 0);
  });

  it('computes aggregate decode + prefill throughput (the headline t/s)', () => {
    const t = parseDs4Timings(REAL_LOG)!;
    // decode: 2172 tokens / 165.66 s ≈ 13.1 t/s (matches the per-request avg)
    expect(t.genTokensPerSec).toBeCloseTo(2172 / ((155.42 + 10.24) / 1), 0);
    expect(t.genTokensPerSec!).toBeGreaterThan(12);
    expect(t.genTokensPerSec!).toBeLessThan(14);
    // prefill is ~10x faster
    expect(t.promptTokensPerSec!).toBeGreaterThan(t.genTokensPerSec!);
  });

  it('returns null for empty, unrelated, or llama-cpp-only logs', () => {
    expect(parseDs4Timings('')).toBeNull();
    expect(parseDs4Timings('some unrelated daemon log\n')).toBeNull();
    // A llama.cpp timing line must NOT be misread as ds4 (disjoint formats).
    expect(
      parseDs4Timings(
        '[llama-server] eval time = 13234.12 ms / 210 tokens ( 63.02 ms per token, 15.87 tokens per second)',
      ),
    ).toBeNull();
  });
});

describe('sumProcessTree', () => {
  // `ps -axo pid=,ppid=,rss=,pcpu=` output: space-padded pid ppid rss pcpu.
  const PS = `
    1     0    9000   0.1
  100     1  410000   8.0
  200   100 20300000  95.0
  201   100    6000   0.5
  300   200    1200   0.0
  999     1   50000   1.0
`;

  it('sums RSS + CPU across the daemon and ALL its descendants (incl. grandchildren)', () => {
    // root=100 (daemon) → 200 (llama-server) → 300 (grandchild), + 201 (sd-server).
    // 999 is an unrelated process and must NOT be counted.
    const r = sumProcessTree(PS, 100)!;
    expect(r).not.toBeNull();
    expect(r.procCount).toBe(4); // 100, 200, 201, 300
    expect(r.rssKb).toBe(410000 + 20300000 + 6000 + 1200);
    expect(r.cpuPercent).toBeCloseTo(8.0 + 95.0 + 0.5 + 0.0, 5);
  });

  it('captures the model RSS the single-PID sampler missed (the whole point)', () => {
    // Sampling only the daemon (100) would report 410 MB; the subtree
    // includes the ~20 GB llama-server child.
    const r = sumProcessTree(PS, 100)!;
    expect(r.rssKb).toBeGreaterThan(20_000_000);
  });

  it('returns null when the root pid is already gone from the snapshot', () => {
    expect(sumProcessTree(PS, 424242)).toBeNull();
  });

  it('handles a leaf root (no children) as just itself', () => {
    const r = sumProcessTree(PS, 999)!;
    expect(r.procCount).toBe(1);
    expect(r.rssKb).toBe(50000);
  });
});

describe('winCpuPercent', () => {
  it('returns 0 for the first sample (no prior baseline)', () => {
    expect(winCpuPercent(undefined, { atMs: 5000, cpuTime100ns: 1_000_000 })).toBe(0);
  });

  it('derives a per-core-equivalent percent from the cumulative-tick delta', () => {
    // 1 full core busy for the whole 5 s interval = 5 s of CPU time =
    // 50,000,000 ticks (100-ns each) → 100%.
    const prev = { atMs: 5000, cpuTime100ns: 0 };
    const curr = { atMs: 10_000, cpuTime100ns: 50_000_000 };
    expect(winCpuPercent(prev, curr)).toBe(100);
  });

  it('can exceed 100% on multi-core work (matches POSIX pcpu semantics)', () => {
    // 2 cores busy across a 5 s interval = 10 s CPU time = 100,000,000 ticks → 200%.
    const prev = { atMs: 0, cpuTime100ns: 0 };
    const curr = { atMs: 5000, cpuTime100ns: 100_000_000 };
    expect(winCpuPercent(prev, curr)).toBe(200);
  });

  it('returns 0 when the counter goes backwards (pid reuse / subtree shrank)', () => {
    const prev = { atMs: 0, cpuTime100ns: 80_000_000 };
    const curr = { atMs: 5000, cpuTime100ns: 10_000_000 };
    expect(winCpuPercent(prev, curr)).toBe(0);
  });

  it('returns 0 on a non-advancing clock (guards divide-by-zero)', () => {
    expect(winCpuPercent({ atMs: 5000, cpuTime100ns: 0 }, { atMs: 5000, cpuTime100ns: 999 })).toBe(
      0,
    );
  });
});

// Real MLX log lines. MLX prints no per-request timing block, so throughput is
// reconstructed from the heartbeat + cache lines the provider already logs.
const MLX_LOG = [
  '2026-07-30T18:32:01.000Z INFO  [chat] [mlx] stream-active tokens=120 · 84 tok/s',
  '2026-07-30T18:32:06.000Z INFO  [chat] [mlx] stream-active tokens=444 · 85 tok/s',
  '2026-07-30T18:32:11.000Z INFO  [chat] [mlx] stream-active tokens=872 · 79 tok/s',
  '2026-07-30T18:40:12.922Z INFO  [chat] [mlx] [cache] reuse cache_id=1d8f6a91 cached_tokens=6976 prefilled_tokens=44',
  '2026-07-30T18:40:20.000Z INFO  [chat] [mlx] stream-active tokens=6 · 101 tok/s',
  '2026-07-30T18:40:25.000Z INFO  [chat] [mlx] stream-active tokens=310 · 98 tok/s',
].join('\n');

describe('parseMlxTimings', () => {
  it('returns null for a log with no MLX signal', () => {
    expect(parseMlxTimings('nothing here')).toBeNull();
  });

  it('does not collide with the llama.cpp parser (each engine matches only its own)', () => {
    expect(parseLlamaCppTimings(MLX_LOG)).toBeNull();
    expect(parseMlxTimings(MLX_LOG)).not.toBeNull();
  });

  it('takes the MEDIAN per-pulse decode rate, not tokens/elapsed', () => {
    // Pulses fire only during active decode, so they already exclude idle and
    // tool-call time; a median resists the low first-pulse reading per turn.
    const t = parseMlxTimings(MLX_LOG);
    expect(t?.genTokensPerSec).toBe(85);
  });

  it('banks each turn peak instead of summing cumulative pulses', () => {
    // `tokens=` is cumulative WITHIN a turn and resets per turn: summing every
    // pulse (120+444+872+6+310) would multiply-count to 1752.
    const t = parseMlxTimings(MLX_LOG);
    expect(t?.genTokens).toBe(872 + 310);
    expect(t?.requestCount).toBe(2);
  });

  it('captures the prefill/cache split MLX reports', () => {
    const t = parseMlxTimings(MLX_LOG);
    expect(t?.promptTokens).toBe(44);
    expect(t?.cachedPromptTokens).toBe(6976);
  });

  it('leaves promptTokensPerSec null — MLX logs no prefill duration', () => {
    expect(parseMlxTimings(MLX_LOG)?.promptTokensPerSec).toBeNull();
  });
});

describe('sumProviderTokens', () => {
  // Regression: the collector read `usage.total.inputTokens`, but UsageSummary
  // has no `total` block — only `providers`. That silently yielded zero tokens
  // for MLX and every cloud/CLI provider.
  it('folds token totals across the providers map', () => {
    const r = sumProviderTokens({
      mlx: { totalTokensIn: 50_500, totalTokensOut: 158, totalCost: 0 },
      openai: { totalTokensIn: 1_000, totalTokensOut: 200, totalCost: 0.42 },
    });
    expect(r).toEqual({ inputTokens: 51_500, outputTokens: 358, costUsd: 0.42 });
  });

  it('distinguishes "nothing reported" (null) from a measured zero', () => {
    expect(sumProviderTokens({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
    expect(sumProviderTokens({ mlx: { totalTokensIn: 0, totalTokensOut: 0 } })).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('tolerates a missing or malformed snapshot', () => {
    expect(sumProviderTokens(null).inputTokens).toBeNull();
    expect(sumProviderTokens({ mlx: 'nope' }).inputTokens).toBeNull();
  });
});
