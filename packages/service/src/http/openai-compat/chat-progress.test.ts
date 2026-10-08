import type { AppChatProgress } from '@bendyline/gezel/app-models';
import { describe, expect, it } from 'vitest';
import { createChatProgressReporter } from './chat-progress.js';

describe('app inference progress', () => {
  it('keeps real prefill percentages separate from reasoning and measured decoding counters', () => {
    const events: AppChatProgress[] = [];
    let now = 0;
    const reporter = createChatProgressReporter(
      (event) => events.push(event),
      () => now,
    );
    reporter.start();
    reporter.engine({
      provider: 'mlx',
      phase: 'prefill',
      progress: 0.42,
      detail: 'private',
      cacheId: 'private-session',
    });
    expect(events.at(-1)).toEqual({
      phase: 'prefill',
      percent: 42,
      outputTokens: null,
      tokensPerSecond: null,
    });
    reporter.activity('reasoning');
    reporter.engine({ provider: 'mlx', phase: 'generating', outputTokens: 12, tokensPerSec: 6 });
    now = 300;
    reporter.engine({ provider: 'mlx', phase: 'generating', outputTokens: 14, tokensPerSec: 7 });
    expect(events.at(-1)).toEqual({
      phase: 'reasoning',
      percent: null,
      outputTokens: 14,
      tokensPerSecond: 7,
    });
    reporter.activity('generating');
    expect(events.at(-1)?.phase).toBe('generating');
    reporter.engine({ provider: 'mlx', phase: 'generating', outputTokens: 15, tokensPerSec: 8 });
    expect(events.at(-1)?.outputTokens).toBe(14);
    reporter.flush();
    expect(events.at(-1)?.outputTokens).toBe(15);
    expect(JSON.stringify(events)).not.toContain('private');
  });
  it('reports ongoing activity at a bounded rate even without token counters', () => {
    let now = 0;
    const events: AppChatProgress[] = [];
    const reporter = createChatProgressReporter(
      (event) => events.push(event),
      () => now,
    );
    reporter.activity('reasoning');
    for (now = 1; now <= 1_000; now += 1) reporter.activity('reasoning');
    expect(events).toHaveLength(5);
    expect(
      events.every((event) => event.phase === 'reasoning' && event.outputTokens === null),
    ).toBe(true);
  });

  it('never invents token counts and ignores malformed engine metrics', () => {
    const events: AppChatProgress[] = [];
    const reporter = createChatProgressReporter((event) => events.push(event));
    reporter.engine({ provider: 'llama-cpp', phase: 'prefill', progress: Number.NaN });
    reporter.activity('generating');
    reporter.engine({
      provider: 'llama-cpp',
      phase: 'generating',
      outputTokens: 2.5,
      tokensPerSec: Number.POSITIVE_INFINITY,
    });
    reporter.flush();
    expect(events.at(-1)).toEqual({
      phase: 'generating',
      percent: null,
      outputTokens: null,
      tokensPerSecond: null,
    });
    reporter.engine({
      provider: 'mlx',
      phase: 'prefill',
      engineQueue: { state: 'waiting', behind: ['another-session'] },
    });
    expect(events.at(-1)?.phase).toBe('queued');
    expect(JSON.stringify(events)).not.toContain('another-session');
  });
});
