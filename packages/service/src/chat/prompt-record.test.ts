import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryManager } from '../history/manager.js';
import { type CompiledPrompt, PROMPT_TEXTS_PER_SESSION, PromptRecorder } from './prompt-record.js';

const session = { id: 'sess-1', projectId: 'spanish', gezelId: 'wren' };

function prompt(systemMessage: string): CompiledPrompt {
  return {
    systemMessage,
    sections: [{ name: 'header', tokens: 3, band: 'stable' }],
    provider: 'llama-cpp',
    model: 'gemma-e4b',
    footprint: 'compact',
    contextWindow: 8192,
  };
}

describe('PromptRecorder', () => {
  let logsDir: string;
  let events: Array<{ kind: string; summary: string; details?: Record<string, unknown> }>;
  let debug: boolean;
  let recorder: PromptRecorder;

  beforeEach(async () => {
    logsDir = await mkdtemp(join(tmpdir(), 'gezel-prompt-record-'));
    events = [];
    debug = false;
    const history = {
      log: async (event: (typeof events)[number]) => {
        events.push(event);
      },
    } as unknown as HistoryManager;
    recorder = new PromptRecorder({ history, logsDir, debugEnabled: () => debug });
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('logs each distinct prompt once, with the tools the engine sent', async () => {
    recorder.compiled(session, prompt('You are Wren.'));
    await recorder.flush(session.id, { count: 2, tokens: 180 });
    recorder.compiled(session, prompt('You are Wren.'));
    await recorder.flush(session.id, { count: 2, tokens: 180 });
    await recorder.flush(session.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('prompt.compiled');
    expect(events[0]?.summary).toContain('+ 2 tools (~180 tokens)');
    expect(events[0]?.details).toMatchObject({
      sessionId: 'sess-1',
      footprint: 'compact',
      contextWindow: 8192,
      sections: [{ name: 'header', tokens: 3, band: 'stable' }],
      tools: { count: 2, tokens: 180 },
    });
    expect(events[0]?.details).not.toHaveProperty('systemMessage');

    recorder.compiled(session, prompt('You are Wren, the tutor.'));
    await recorder.flush(session.id);
    expect(events).toHaveLength(2);
  });

  it('keeps no prompt text outside debug mode', async () => {
    recorder.compiled(session, prompt('You are Wren.'));
    await recorder.flush(session.id);
    await expect(readdir(join(logsDir, 'prompts'))).rejects.toThrow();
  });

  it('keeps the last prompt texts per session in debug mode', async () => {
    debug = true;
    for (let i = 0; i < PROMPT_TEXTS_PER_SESSION + 2; i += 1) {
      recorder.compiled(session, {
        ...prompt(`You are Wren, version ${i}.`),
        volatileContext: 'Task 3',
      });
      await recorder.flush(session.id, { count: 1, tokens: 40 });
    }
    const dir = join(logsDir, 'prompts', session.id);
    const files = (await readdir(dir)).sort();
    expect(files).toHaveLength(PROMPT_TEXTS_PER_SESSION);
    const newest = await readFile(join(dir, files[files.length - 1]!), 'utf8');
    expect(newest).toContain(`You are Wren, version ${PROMPT_TEXTS_PER_SESSION + 1}.`);
    expect(newest).toContain('## Volatile context');
    expect(newest).toContain('| header | stable | 3 |');
  });

  it('never writes a session id that is not a plain name', async () => {
    debug = true;
    recorder.compiled({ ...session, id: '../escape' }, prompt('You are Wren.'));
    await recorder.flush('../escape');
    await expect(readdir(join(logsDir, 'prompts'))).rejects.toThrow();
    expect(events).toHaveLength(1);
  });
});
