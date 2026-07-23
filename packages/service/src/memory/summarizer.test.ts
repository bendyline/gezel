import type { ChatSession } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import type { MemoryManager } from './manager.js';
import { markSessionSummarized, summarizeSessionForMemory } from './summarizer.js';

function session(opts: {
  userTurns: number;
  summarizedUpTo?: number;
}): ChatSession {
  const messages: ChatSession['messages'] = [];
  for (let i = 0; i < opts.userTurns; i++) {
    messages.push({ role: 'user', content: `user ${i}`, at: 'now' });
    messages.push({ role: 'assistant', content: `reply ${i}`, at: 'now' });
  }
  return {
    version: 1,
    id: 'sess-1',
    gezelId: 'ada',
    projectId: 'default',
    providerName: 'copilot',
    title: 'Working on auth',
    createdAt: '2026-04-10T00:00:00Z',
    lastActivityAt: '2026-04-10T00:05:00Z',
    messages,
    providerState: {},
    ...(opts.summarizedUpTo !== undefined ? { summarizedUpTo: opts.summarizedUpTo } : {}),
  };
}

function stubMemoryAndChat(canned: string): {
  memory: MemoryManager;
  chat: ChatManager;
  saved: string[];
  savedDetailed: Array<{ scope: string; id: string; text: string; kind: string | undefined }>;
  oneShotCalls: Array<{ prompt: string; opts: unknown }>;
} {
  const saved: string[] = [];
  const savedDetailed: Array<{
    scope: string;
    id: string;
    text: string;
    kind: string | undefined;
  }> = [];
  const oneShotCalls: Array<{ prompt: string; opts: unknown }> = [];
  const memory = {
    save: async (scope: string, id: string, text: string, kind?: string) => {
      saved.push(text);
      savedDetailed.push({ scope, id, text, kind });
      return { status: 'saved' as const };
    },
  } as unknown as MemoryManager;
  const chat = {
    oneShotCompletion: async (prompt: string, _timeoutMs: number, opts: unknown) => {
      oneShotCalls.push({ prompt, opts });
      return canned;
    },
  } as unknown as ChatManager;
  return { memory, chat, saved, savedDetailed, oneShotCalls };
}

describe('summarizeSessionForMemory', () => {
  it('saves one memory per line returned by the summarizer', async () => {
    const { memory, chat, saved } = stubMemoryAndChat(
      'Decided to use pgvector for embeddings.\nUser wants terse replies.\n',
    );
    await summarizeSessionForMemory({
      record: session({ userTurns: 3 }),
      chat,
      memory,
      config: {},
      trigger: 'archive',
    });
    expect(saved).toEqual(['Decided to use pgvector for embeddings.', 'User wants terse replies.']);
  });

  it('parses kind tags off summary lines and saves to project scope', async () => {
    const { memory, chat, savedDetailed } = stubMemoryAndChat(
      'DECISION: Use pgvector for embeddings.\nPREF: User wants terse replies.\nSTATUS: The staging API key is still missing.\nFACT: Auth lives in src/auth.ts.\n',
    );
    await summarizeSessionForMemory({
      record: session({ userTurns: 3 }),
      chat,
      memory,
      config: {},
      trigger: 'archive',
    });
    expect(savedDetailed).toEqual([
      { scope: 'project', id: 'default', text: 'Use pgvector for embeddings.', kind: 'decision' },
      { scope: 'project', id: 'default', text: 'User wants terse replies.', kind: 'pref' },
      {
        scope: 'project',
        id: 'default',
        text: 'The staging API key is still missing.',
        kind: 'status',
      },
      { scope: 'project', id: 'default', text: 'Auth lives in src/auth.ts.', kind: 'fact' },
    ]);
  });

  it('untagged summary lines default to kind fact', async () => {
    const { memory, chat, savedDetailed } = stubMemoryAndChat('A line with no tag at all.\n');
    await summarizeSessionForMemory({
      record: session({ userTurns: 3 }),
      chat,
      memory,
      config: {},
      trigger: 'archive',
    });
    expect(savedDetailed).toEqual([
      { scope: 'project', id: 'default', text: 'A line with no tag at all.', kind: 'fact' },
    ]);
  });

  it('instructs the summarizer to skip completion status and to tag kinds', async () => {
    const { memory, chat, oneShotCalls } = stubMemoryAndChat('NONE');
    await summarizeSessionForMemory({
      record: session({ userTurns: 3 }),
      chat,
      memory,
      config: {},
      trigger: 'archive',
    });
    const prompt = oneShotCalls[0]!.prompt;
    expect(prompt).toContain('Do NOT record task or project completion');
    expect(prompt).toContain('FACT:');
    expect(prompt).toContain('STATUS:');
  });

  it('skips sessions under the min-user-turns threshold', async () => {
    const { memory, chat, saved, oneShotCalls } = stubMemoryAndChat('something');
    await summarizeSessionForMemory({
      record: session({ userTurns: 1 }),
      chat,
      memory,
      config: {},
      trigger: 'archive',
    });
    expect(saved).toEqual([]);
    expect(oneShotCalls).toEqual([]);
  });

  it('respects a configured minUserTurns override', async () => {
    const { memory, chat, saved, oneShotCalls } = stubMemoryAndChat('something');
    await summarizeSessionForMemory({
      record: session({ userTurns: 3 }),
      chat,
      memory,
      config: { summarization: { minUserTurns: 5 } },
      trigger: 'archive',
    });
    expect(saved).toEqual([]);
    expect(oneShotCalls).toEqual([]);
  });

  it('skips when the session has not advanced past summarizedUpTo', async () => {
    const rec = session({ userTurns: 3, summarizedUpTo: 6 }); // 3 user + 3 assistant = 6
    const { memory, chat, saved, oneShotCalls } = stubMemoryAndChat('something');
    await summarizeSessionForMemory({
      record: rec,
      chat,
      memory,
      config: {},
      trigger: 'archive',
    });
    expect(saved).toEqual([]);
    expect(oneShotCalls).toEqual([]);
  });

  it('returns without saving when the summarizer responds NONE', async () => {
    const { memory, chat, saved } = stubMemoryAndChat('NONE');
    await summarizeSessionForMemory({
      record: session({ userTurns: 3 }),
      chat,
      memory,
      config: {},
      trigger: 'archive',
    });
    expect(saved).toEqual([]);
  });

  it('passes the configured provider + model through to oneShotCompletion', async () => {
    const { memory, chat, oneShotCalls } = stubMemoryAndChat('decision: yes');
    await summarizeSessionForMemory({
      record: session({ userTurns: 3 }),
      chat,
      memory,
      config: {
        summarization: { provider: 'ollama', model: 'llama3.2' },
      },
      trigger: 'archive',
    });
    expect(oneShotCalls).toHaveLength(1);
    expect(oneShotCalls[0]!.opts).toMatchObject({
      providerName: 'ollama',
      model: 'llama3.2',
    });
  });

  it('is disabled when config.summarization.enabled is false', async () => {
    const { memory, chat, saved, oneShotCalls } = stubMemoryAndChat('x');
    await summarizeSessionForMemory({
      record: session({ userTurns: 5 }),
      chat,
      memory,
      config: { summarization: { enabled: false } },
      trigger: 'archive',
    });
    expect(saved).toEqual([]);
    expect(oneShotCalls).toEqual([]);
  });

  it('swallows provider errors so archive never crashes', async () => {
    const chat = {
      oneShotCompletion: async () => {
        throw new Error('provider down');
      },
    } as unknown as ChatManager;
    const memory = {
      save: async () => {},
    } as unknown as MemoryManager;
    await expect(
      summarizeSessionForMemory({
        record: session({ userTurns: 3 }),
        chat,
        memory,
        config: {},
        trigger: 'archive',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('markSessionSummarized', () => {
  it('stamps summarizedAt and summarizedUpTo = messages.length', () => {
    const rec = session({ userTurns: 2 });
    markSessionSummarized(rec);
    expect(rec.summarizedUpTo).toBe(4);
    expect(typeof rec.summarizedAt).toBe('string');
  });
});
