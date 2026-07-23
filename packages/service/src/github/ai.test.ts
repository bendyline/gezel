import { describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { FileTooLargeForAiError, proposeMergeResolution, suggestCommitMessage } from './ai.js';

/**
 * The AI helpers only need `oneShotCompletion` from the manager — same
 * mocking approach as about/project-generator.test.ts.
 */
function mockChat(response: string) {
  const oneShotCompletion = vi.fn().mockResolvedValue(response);
  return { chat: { oneShotCompletion } as unknown as ChatManager, oneShotCompletion };
}

describe('suggestCommitMessage', () => {
  it('passes the diff and changed paths through and returns the sentence', async () => {
    const { chat, oneShotCompletion } = mockChat('Updated the README intro wording.');
    const message = await suggestCommitMessage(chat, {
      diff: '+hello\n-goodbye',
      changedPaths: ['README.md', 'docs/intro.md'],
    });
    expect(message).toBe('Updated the README intro wording.');
    const prompt = oneShotCompletion.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('+hello');
    expect(prompt).toContain('README.md, docs/intro.md');
  });

  it('strips wrapping quotes and fences and keeps only the first line', async () => {
    const { chat } = mockChat('```\n"Tweaked the pet shop pricing copy."\nExtra rambling.\n```');
    const message = await suggestCommitMessage(chat, { diff: 'x', changedPaths: ['a'] });
    expect(message).toBe('Tweaked the pet shop pricing copy.');
  });

  it('head-truncates oversized diffs before prompting', async () => {
    const { chat, oneShotCompletion } = mockChat('ok');
    await suggestCommitMessage(chat, { diff: 'y'.repeat(40_000), changedPaths: ['big.txt'] });
    const prompt = oneShotCompletion.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('[…diff truncated]');
    expect(prompt.length).toBeLessThan(35_000);
  });
});

describe('proposeMergeResolution', () => {
  it('returns the fenced merged file content', async () => {
    const { chat, oneShotCompletion } = mockChat('```merged\nline one\nline two\n```');
    const merged = await proposeMergeResolution(chat, {
      path: 'notes.md',
      base: 'base',
      ours: 'mine',
      theirs: 'theirs',
    });
    expect(merged).toBe('line one\nline two');
    const prompt = oneShotCompletion.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('<yours — the local version>');
    expect(prompt).toContain('<from-github — the remote version>');
    expect(prompt).toContain('<base — the version both started from>');
  });

  it('omits the base section when both sides added the file', async () => {
    const { chat, oneShotCompletion } = mockChat('```\nx\n```');
    await proposeMergeResolution(chat, { path: 'a.txt', ours: 'm', theirs: 't' });
    const prompt = oneShotCompletion.mock.calls[0]?.[0] as string;
    expect(prompt).not.toContain('<base');
  });

  it('throws when the model returns no fence (UI falls back to manual)', async () => {
    const { chat } = mockChat('I think you should merge them carefully.');
    await expect(
      proposeMergeResolution(chat, { path: 'a.txt', ours: 'm', theirs: 't' }),
    ).rejects.toThrow(/did not return a combined file/);
  });

  it('rejects oversized payloads with FileTooLargeForAiError before prompting', async () => {
    const { chat, oneShotCompletion } = mockChat('never called');
    await expect(
      proposeMergeResolution(chat, {
        path: 'huge.txt',
        ours: 'a'.repeat(30_000),
        theirs: 'b'.repeat(30_000),
      }),
    ).rejects.toBeInstanceOf(FileTooLargeForAiError);
    expect(oneShotCompletion).not.toHaveBeenCalled();
  });
});
