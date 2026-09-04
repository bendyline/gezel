import { describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { buildTransformPrompt, rewriteText, transformText } from './generator.js';

describe('buildTransformPrompt', () => {
  it('rewrite mode always uses the fragment scope and includes the input', () => {
    const prompt = buildTransformPrompt({ mode: 'rewrite', text: 'Some prose.' });
    expect(prompt).toContain('FRAGMENT from within a larger document');
    expect(prompt).toContain('## Input\nSome prose.');
    expect(prompt).not.toContain('COMPLETE document');
    expect(prompt).not.toContain('insertion point');
  });

  it('puts the user instruction ahead of default guidance', () => {
    const prompt = buildTransformPrompt({
      mode: 'rewrite',
      text: 'x',
      instruction: 'make it terser',
    });
    expect(prompt).toContain('"make it terser"');
    expect(prompt).toContain('Follow that instruction first');
    expect(prompt).not.toContain('No specific instruction was provided');
  });

  it('insert mode carries the insertion scope note and surrounding context blocks', () => {
    const prompt = buildTransformPrompt({
      mode: 'insert',
      text: '',
      instruction: 'add a summary paragraph',
      textBefore: 'The end of the intro.',
      textAfter: 'The next section.',
    });
    expect(prompt).toContain('INSERTING new content at a marked position');
    expect(prompt).toContain('## Text before the insertion point\nThe end of the intro.');
    expect(prompt).toContain('## Text after the insertion point\nThe next section.');
    expect(prompt).toContain('ONLY the new markdown content to insert');
    expect(prompt).not.toContain('## Input');
  });

  it('includes the squisq dialect note only for document-surface contexts', () => {
    const generic = buildTransformPrompt({ mode: 'rewrite', text: 'x' });
    expect(generic).toContain('### Squisq extended markdown');
    expect(generic).toContain('```mermaid');
    expect(generic).toContain('{[dataTable]}');

    const task = buildTransformPrompt({
      mode: 'insert',
      text: '',
      instruction: 'write it',
      context: 'task-description',
    });
    expect(task).toContain('### Squisq extended markdown');

    // about.md becomes a model's system prompt — a mermaid diagram there
    // is noise, so the dialect note must stay out.
    const about = buildTransformPrompt({ mode: 'rewrite', text: 'x', context: 'about' });
    expect(about).not.toContain('Squisq extended markdown');

    const chat = buildTransformPrompt({ mode: 'rewrite', text: 'x', context: 'chat-composer' });
    expect(chat).not.toContain('Squisq extended markdown');
  });

  it('includes subject and parent context blocks when supplied', () => {
    const prompt = buildTransformPrompt({
      mode: 'rewrite',
      text: 'x',
      context: 'task-description',
      subject: 'Fix the login flow',
      parentContext: 'Project: Website revamp',
    });
    expect(prompt).toContain('## Subject\nFix the login flow');
    expect(prompt).toContain('## Parent context\nProject: Website revamp');
  });
});

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
      return '```markdown\nResult text.\n```';
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
