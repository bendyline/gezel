import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completionBudgetChars,
  runLargeContentCompletion,
  splitContentWindows,
} from './large-content.js';

afterEach(() => {
  delete process.env.GEZEL_COMPLETION_BUDGET_CHARS;
});

describe('completionBudgetChars', () => {
  it('gives cloud targets a whole-file budget and local targets a small one', () => {
    expect(completionBudgetChars('openai')).toBeGreaterThan(completionBudgetChars('llama-cpp'));
    expect(completionBudgetChars('mlx')).toBe(completionBudgetChars('ollama'));
    expect(completionBudgetChars(undefined)).toBe(completionBudgetChars('llama-cpp'));
  });

  it('honors the env override', () => {
    process.env.GEZEL_COMPLETION_BUDGET_CHARS = '5000';
    expect(completionBudgetChars('openai')).toBe(5000);
  });
});

describe('splitContentWindows', () => {
  it('returns one window carrying everything when the content fits', () => {
    const windows = splitContentWindows('a\nb\nc', { budgetChars: 100 });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ lineStart: 1, lineEnd: 3, totalLines: 3, count: 1 });
    expect(windows[0]!.text).toBe('a\nb\nc');
  });

  it('splits on line boundaries with absolute line numbers and overlap', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}-${'x'.repeat(20)}`);
    const content = lines.join('\n');
    const windows = splitContentWindows(content, { budgetChars: 600, overlapLines: 3 });
    expect(windows.length).toBeGreaterThan(2);
    expect(windows[0]!.lineStart).toBe(1);
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1]!;
      const cur = windows[i]!;
      // Overlap: each window starts 3 lines before its predecessor's end.
      expect(cur.lineStart).toBe(prev.lineEnd - 3 + 1);
      expect(cur.text.split('\n')[0]).toBe(lines[cur.lineStart - 1]);
      expect(cur.text.length).toBeLessThanOrEqual(600);
    }
    expect(windows.at(-1)!.lineEnd).toBe(100);
  });

  it('never loops on a single line larger than the budget', () => {
    const windows = splitContentWindows(`${'x'.repeat(500)}\n${'y'.repeat(500)}`, {
      budgetChars: 100,
    });
    expect(windows).toHaveLength(2);
    expect(windows[0]!.lineStart).toBe(1);
    expect(windows[1]!.lineStart).toBe(2);
  });
});

describe('runLargeContentCompletion', () => {
  it('runs windows sequentially and reports the cost-bound truncation', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `l${i}-${'x'.repeat(30)}`);
    const complete = vi.fn(async (p: string) => `got:${p.length}`);
    const run = await runLargeContentCompletion(
      complete,
      lines.join('\n'),
      (w) => `[${w.index + 1}/${w.count} @${w.lineStart}]\n${w.text}`,
      { budgetChars: 400, maxWindows: 2 },
    );
    expect(run.refused).toBeUndefined();
    expect(run.replies).toHaveLength(2);
    expect(run.totalWindows).toBeGreaterThan(2);
    expect(run.truncated).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(run.replies[0]!.window.lineStart).toBe(1);
  });

  it('a throwing completion yields an empty raw, not a rejection', async () => {
    const run = await runLargeContentCompletion(
      async () => {
        throw new Error('engine down');
      },
      'hello',
      (w) => w.text,
      { budgetChars: 100, maxWindows: 1 },
    );
    expect(run.replies[0]!.raw).toBe('');
  });

  it('propagates cancellation instead of continuing through later windows', async () => {
    const abort = new Error('service shutting down');
    abort.name = 'AbortError';
    const complete = vi.fn(async () => {
      throw abort;
    });

    await expect(
      runLargeContentCompletion(
        complete,
        Array.from({ length: 20 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n'),
        (w) => w.text,
        { budgetChars: 150, maxWindows: 10 },
      ),
    ).rejects.toBe(abort);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('refuses content over the absolute ceiling without calling the model', async () => {
    const complete = vi.fn(async () => 'never');
    const run = await runLargeContentCompletion(
      complete,
      'x'.repeat(100 * 1024 * 1024 + 1),
      (w) => w.text,
      { budgetChars: 1000, maxWindows: 1 },
    );
    expect(run.refused).toBe('over-ceiling');
    expect(complete).not.toHaveBeenCalled();
  });
});
