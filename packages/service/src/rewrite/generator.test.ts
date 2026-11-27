import { describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { rewriteText, transformText } from './generator.js';

// buildTransformPrompt is core's (re-exported by ./generator.js) and is tested
// in packages/core/src/transform/prompt.test.ts.

describe('transformText', () => {
  function managerWith(
    impl: (
      prompt: string,
      timeoutMs: number,
      opts: {
        onDelta?: (chunk: string) => void;
        onReasoningDelta?: (chunk: string) => void;
        onQueueWait?: (info: { aheadOf: number }) => void;
        useKlerk?: boolean;
        lane?: 'interactive' | 'background';
        jobLabel?: string;
      },
    ) => Promise<string>,
  ): ChatManager {
    return { oneShotCompletion: vi.fn(impl) } as unknown as ChatManager;
  }

  it('routes through the Klerk, splits inline think tags, and strips fences', async () => {
    const thinking: string[] = [];
    const output: string[] = [];
    const manager = managerWith(async (_prompt, _timeout, opts) => {
      expect(opts.useKlerk).toBe(true);
      expect(opts.lane).toBe('interactive');
      expect(opts.jobLabel).toBe('transform · rewrite');
      opts.onDelta?.('<think>considering tone</think>');
      opts.onDelta?.('Result ');
      opts.onDelta?.('text.');
      return '<think>final reasoning</think>\n```markdown\nResult text.\n```';
    });
    const result = await transformText(
      manager,
      { mode: 'rewrite', text: 'input' },
      { onThinking: (t) => thinking.push(t), onOutput: (t) => output.push(t) },
    );
    expect(result).toBe('Result text.');
    expect(thinking.join('')).toBe('considering tone');
    expect(output.join('')).toBe('Result text.');
  });

  it('forwards real reasoning deltas and queue waits', async () => {
    const thinking: string[] = [];
    const queued: number[] = [];
    const manager = managerWith(async (_prompt, _timeout, opts) => {
      opts.onQueueWait?.({ aheadOf: 2 });
      opts.onReasoningDelta?.('deep thought');
      return 'done';
    });
    const result = await transformText(
      manager,
      { mode: 'insert', text: '', instruction: 'write intro', context: 'about' },
      { onThinking: (t) => thinking.push(t), onQueued: (n) => queued.push(n) },
    );
    expect(result).toBe('done');
    expect(thinking.join('')).toBe('deep thought');
    expect(queued).toEqual([2]);
  });

  it('routes the legacy blocking rewrite through the interactive lane too', async () => {
    const manager = managerWith(async (_prompt, _timeout, opts) => {
      expect(opts.useKlerk).toBe(true);
      expect(opts.lane).toBe('interactive');
      return 'clean copy';
    });

    await expect(rewriteText(manager, { text: 'rough copy' })).resolves.toBe('clean copy');
  });
});
