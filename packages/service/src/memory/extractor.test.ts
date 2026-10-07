import type { ChatMessage } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { extractMemories, parseExtractedLine } from './extractor.js';
import type { MemoryManager } from './manager.js';

describe('parseExtractedLine', () => {
  it('parses full SCOPE/KIND tags', () => {
    expect(parseExtractedLine('PROJECT/FACT: Sessions are stored as JSON.')).toEqual({
      scope: 'project',
      kind: 'fact',
      text: 'Sessions are stored as JSON.',
    });
    expect(parseExtractedLine('GEZEL/PREF: User prefers terse replies.')).toEqual({
      scope: 'gezel',
      kind: 'pref',
      text: 'User prefers terse replies.',
    });
    expect(parseExtractedLine('PROJECT/STATUS: API key currently missing.')).toEqual({
      scope: 'project',
      kind: 'status',
      text: 'API key currently missing.',
    });
  });

  it('is case-insensitive and tolerant of spacing around the tag', () => {
    expect(parseExtractedLine('project / decision : Chose sqlite-vec.')).toEqual({
      scope: 'project',
      kind: 'decision',
      text: 'Chose sqlite-vec.',
    });
    expect(parseExtractedLine('Gezel/Pref:User likes tabs.')).toEqual({
      scope: 'gezel',
      kind: 'pref',
      text: 'User likes tabs.',
    });
  });

  it('strips leading bullets and numbering from tagged lines', () => {
    expect(parseExtractedLine('- PROJECT/FACT: Bulleted anyway.')).toEqual({
      scope: 'project',
      kind: 'fact',
      text: 'Bulleted anyway.',
    });
    expect(parseExtractedLine('2. GEZEL/PREF: Numbered anyway.')).toEqual({
      scope: 'gezel',
      kind: 'pref',
      text: 'Numbered anyway.',
    });
  });

  it('routes kind-only tags: PREF → user, CORRECTION/EXAMPLE → gezel, others → project', () => {
    expect(parseExtractedLine('PREF: Short commit messages.')).toEqual({
      scope: 'user',
      kind: 'pref',
      text: 'Short commit messages.',
    });
    expect(parseExtractedLine('CORRECTION: "Estoy cansado", not "soy cansado".')).toEqual({
      scope: 'gezel',
      kind: 'correction',
      text: '"Estoy cansado", not "soy cansado".',
    });
    expect(parseExtractedLine('USER/EXAMPLE: A two-line summary first worked well.')).toEqual({
      scope: 'user',
      kind: 'example',
      text: 'A two-line summary first worked well.',
    });
    expect(parseExtractedLine('DECISION: Use Hono for routing.')).toEqual({
      scope: 'project',
      kind: 'decision',
      text: 'Use Hono for routing.',
    });
    expect(parseExtractedLine('STATUS: Build currently failing on CI.')).toEqual({
      scope: 'project',
      kind: 'status',
      text: 'Build currently failing on CI.',
    });
  });

  it('falls back to project/fact for untagged lines', () => {
    expect(parseExtractedLine('The deploy script lives in scripts/deploy.sh.')).toEqual({
      scope: 'project',
      kind: 'fact',
      text: 'The deploy script lives in scripts/deploy.sh.',
    });
  });

  it('drops empty lines and the NONE sentinel', () => {
    expect(parseExtractedLine('')).toBeNull();
    expect(parseExtractedLine('   ')).toBeNull();
    expect(parseExtractedLine('NONE')).toBeNull();
    expect(parseExtractedLine('- NONE')).toBeNull();
  });
});

function recordingMemory(): {
  memory: MemoryManager;
  saves: Array<{ scope: string; id: string; text: string; kind: string | undefined }>;
  sources: unknown[];
} {
  const saves: Array<{ scope: string; id: string; text: string; kind: string | undefined }> = [];
  const sources: unknown[] = [];
  const memory = {
    save: async (scope: string, id: string, text: string, kind?: string, source?: unknown) => {
      saves.push({ scope, id, text, kind });
      sources.push(source);
      return { status: 'saved' as const };
    },
  } as unknown as MemoryManager;
  return { memory, saves, sources };
}

const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({
  role,
  content,
  at: 'now',
});

const messages: ChatMessage[] = [
  msg('user', 'Please set up the deploy pipeline.'),
  msg('assistant', 'Done — I added scripts/deploy.sh.'),
];

describe('extractMemories routing', () => {
  it('routes each scope to its own owner and records where every line came from', async () => {
    const { memory, saves, sources } = recordingMemory();
    await extractMemories({
      messages,
      extractedUpTo: 0,
      oneShot: async () =>
        'PROJECT/FACT: Deploy pipeline lives in scripts/deploy.sh.\nGEZEL/PREF: User prefers concise status updates.\nUSER/FACT: The user lives in Utrecht.\n',
      memory,
      gezelId: 'ada',
      projectId: 'proj-1',
    });
    expect(sources).toEqual([
      { project: 'proj-1', gezel: 'ada' },
      { project: 'proj-1', gezel: 'ada' },
      { project: 'proj-1', gezel: 'ada' },
    ]);
    expect(saves).toEqual([
      {
        scope: 'project',
        id: 'proj-1',
        text: 'Deploy pipeline lives in scripts/deploy.sh.',
        kind: 'fact',
      },
      {
        scope: 'gezel',
        id: 'ada',
        text: 'User prefers concise status updates.',
        kind: 'pref',
      },
      { scope: 'user', id: 'user', text: 'The user lives in Utrecht.', kind: 'fact' },
    ]);
  });

  /**
   * A model that repeats its instructions instead of answering hands back the
   * prompt's own few-shot examples — correctly tagged, so they parse and save
   * as if the crew had remembered them, and then ride into later prompts as
   * recalled context. Wild-caught in unified search, where "Sessions are
   * stored as JSON files under the data directory." came back four times for
   * an unrelated query.
   */
  it('stores nothing when the reply is the prompt echoed back', async () => {
    const { memory, saves } = recordingMemory();
    await extractMemories({
      messages,
      extractedUpTo: 0,
      oneShot: async (prompt) => `Mock reply: ${prompt}`,
      memory,
      gezelId: 'ada',
      projectId: 'proj-1',
    });
    expect(saves).toEqual([]);
  });

  it('rejects the prompt’s own examples when only they come back', async () => {
    const { memory, saves } = recordingMemory();
    await extractMemories({
      messages,
      extractedUpTo: 0,
      oneShot: async () =>
        [
          'PROJECT/FACT: Sessions are stored as JSON files under the data directory.',
          'PROJECT/DECISION: Chose sqlite-vec over Vectra for the memory index.',
          'GEZEL/PREF: The user prefers terse replies without emojis.',
          'PROJECT/STATUS: The OpenAI API key is currently missing from config.',
          // The one genuine line in the reply must still survive.
          'PROJECT/FACT: Deploy pipeline lives in scripts/deploy.sh.',
        ].join('\n'),
      memory,
      gezelId: 'ada',
      projectId: 'proj-1',
    });
    expect(saves).toEqual([
      {
        scope: 'project',
        id: 'proj-1',
        text: 'Deploy pipeline lives in scripts/deploy.sh.',
        kind: 'fact',
      },
    ]);
  });

  it('saves nothing on NONE', async () => {
    const { memory, saves } = recordingMemory();
    await extractMemories({
      messages,
      extractedUpTo: 0,
      oneShot: async () => 'NONE',
      memory,
      gezelId: 'ada',
      projectId: 'proj-1',
    });
    expect(saves).toEqual([]);
  });

  it('prompt identifies itself and excludes completion status', async () => {
    let prompt = '';
    const { memory } = recordingMemory();
    await extractMemories({
      messages,
      extractedUpTo: 0,
      oneShot: async (p) => {
        prompt = p;
        return 'NONE';
      },
      memory,
      gezelId: 'ada',
      projectId: 'proj-1',
    });
    expect(prompt).toContain('memory extraction system');
    expect(prompt).toContain('Do NOT record task or project completion');
  });
});

describe('extractMemories cursor windows', () => {
  const six: ChatMessage[] = [
    msg('user', 'turn-one question'),
    msg('assistant', 'turn-one answer'),
    msg('user', 'turn-two question'),
    msg('assistant', 'turn-two answer'),
    msg('user', 'turn-three question'),
    msg('assistant', 'turn-three answer'),
  ];

  it('puts only post-cursor messages under New messages, with 2 prior as context', async () => {
    let prompt = '';
    const { memory } = recordingMemory();
    await extractMemories({
      messages: six,
      extractedUpTo: 4,
      oneShot: async (p) => {
        prompt = p;
        return 'NONE';
      },
      memory,
      gezelId: 'ada',
      projectId: 'proj-1',
    });
    const [before, after] = prompt.split('New messages:');
    expect(after).toContain('turn-three question');
    expect(after).toContain('turn-three answer');
    expect(after).not.toContain('turn-two');
    expect(before).toContain('Earlier context');
    expect(before).toContain('turn-two question');
    expect(before).toContain('turn-two answer');
    expect(before).not.toContain('turn-one');
  });

  it('omits the context block when the cursor is 0', async () => {
    let prompt = '';
    const { memory } = recordingMemory();
    await extractMemories({
      messages: six,
      extractedUpTo: 0,
      oneShot: async (p) => {
        prompt = p;
        return 'NONE';
      },
      memory,
      gezelId: 'ada',
      projectId: 'proj-1',
    });
    expect(prompt).not.toContain('Earlier context');
    expect(prompt).toContain('turn-one question');
    expect(prompt).toContain('turn-three answer');
  });

  it('no-ops when nothing is past the cursor', async () => {
    let called = false;
    const { memory } = recordingMemory();
    await extractMemories({
      messages: six,
      extractedUpTo: 6,
      oneShot: async () => {
        called = true;
        return 'NONE';
      },
      memory,
      gezelId: 'ada',
      projectId: 'proj-1',
    });
    expect(called).toBe(false);
  });

  it('no-ops when the cursor is beyond the transcript length', async () => {
    let called = false;
    const { memory } = recordingMemory();
    await extractMemories({
      messages: six,
      extractedUpTo: 99,
      oneShot: async () => {
        called = true;
        return 'NONE';
      },
      memory,
      gezelId: 'ada',
      projectId: 'proj-1',
    });
    expect(called).toBe(false);
  });
});

describe('extractMemories when the one-shot does not answer', () => {
  it('rethrows a cancellation so the caller keeps its cursor', async () => {
    const { memory, saves } = recordingMemory();
    const cancelled = Object.assign(new Error('service shutting down'), { name: 'AbortError' });
    await expect(
      extractMemories({
        messages,
        extractedUpTo: 0,
        oneShot: async () => {
          throw cancelled;
        },
        memory,
        gezelId: 'ada',
        projectId: 'proj-1',
      }),
    ).rejects.toBe(cancelled);
    expect(saves).toEqual([]);
  });

  it('swallows an ordinary failure', async () => {
    const { memory, saves } = recordingMemory();
    await expect(
      extractMemories({
        messages,
        extractedUpTo: 0,
        oneShot: async () => {
          throw new Error('one-shot timed out after 30s');
        },
        memory,
        gezelId: 'ada',
        projectId: 'proj-1',
      }),
    ).resolves.toBeUndefined();
    expect(saves).toEqual([]);
  });
});
