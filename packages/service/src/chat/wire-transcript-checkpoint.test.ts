import type { ChatMessage } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { MlxProvider } from '../providers/mlx/provider.js';
import { mlxWireTranscript } from '../providers/mlx/wire-transcript.js';
import type { WireTranscriptEntry } from '../providers/types.js';
import {
  buildWireTranscriptCheckpoint,
  restoreFromWireTranscript,
  wireTranscriptIsPaired,
} from './wire-transcript-checkpoint.js';

function msg(role: 'user' | 'assistant', content: string, at: string, extra = {}): ChatMessage {
  return { role, content, at, ...extra } as ChatMessage;
}

const history: ChatMessage[] = [
  msg('user', 'Review the README.', '2026-10-05T10:00:00.000Z'),
  msg('assistant', 'Done — two issues.', '2026-10-05T10:01:00.000Z'),
  msg('user', 'Now write the report.', '2026-10-05T10:02:00.000Z'),
];

const transcript: WireTranscriptEntry[] = [
  { role: 'user', content: 'Review the README.' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call-1', name: 'read_file', arguments: '{"path":"README.md","startLine":1}' },
    ],
  },
  { role: 'tool', content: '# Project\n...', toolCallId: 'call-1' },
  { role: 'assistant', content: 'Done — two issues.' },
  { role: 'user', content: '[Current date and time: …]\n\nNow write the report.' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call-2', name: 'write_artifact', arguments: '{"path":"report.md","content":"…"}' },
    ],
  },
  { role: 'tool', content: 'Wrote report.md', toolCallId: 'call-2' },
];

function checkpoint(messages: readonly ChatMessage[], inTurn: boolean, entries = transcript) {
  return buildWireTranscriptCheckpoint({
    sessionId: 'sess',
    providerName: 'mlx',
    inTurn,
    messages,
    transcript: entries,
    savedAt: '2026-10-05T10:03:00.000Z',
  });
}

describe('restoreFromWireTranscript', () => {
  it('reseeds with the exact transcript when the saved history is the checkpoint basis', () => {
    const restored = restoreFromWireTranscript(checkpoint(history, true), {
      providerName: 'mlx',
      messages: history,
    });
    expect(restored).toEqual({ ok: true, entries: transcript, note: 'exact' });
  });

  it('drops the interrupted turn’s aborted reply — its finished rounds are already in the checkpoint', () => {
    const aborted = msg('assistant', 'partial', '2026-10-05T10:04:00.000Z', {
      synthetic: 'turn-aborted',
      toolCalls: [{ name: 'write_artifact' }],
    });
    const restored = restoreFromWireTranscript(checkpoint(history, true), {
      providerName: 'mlx',
      messages: [...history, aborted],
    });
    expect(restored).toMatchObject({ ok: true, entries: transcript, note: 'interrupted turn' });
  });

  it('appends a final reply the process died before checkpointing', () => {
    const reply = msg(
      'assistant',
      '<think>plan</think>The report is ready.',
      '2026-10-05T10:04:00.000Z',
    );
    const restored = restoreFromWireTranscript(checkpoint(history, true), {
      providerName: 'mlx',
      messages: [...history, reply],
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.entries.at(-1)).toEqual({
        role: 'assistant',
        content: 'The report is ready.',
      });
    }
  });

  it('ignores the pending user message a send is about to supply', () => {
    const restored = restoreFromWireTranscript(
      checkpoint(history, false),
      {
        providerName: 'mlx',
        messages: [...history, msg('user', 'Thanks!', '2026-10-05T10:05:00.000Z')],
      },
      { omitLastUser: true },
    );
    expect(restored.ok).toBe(true);
  });

  it.each([
    [
      'a user message the checkpoint never saw',
      [...history, msg('user', 'Another ask', '2026-10-05T10:05:00.000Z')],
      true,
    ],
    [
      'an edited history',
      [history[0]!, msg('assistant', 'Edited.', history[1]!.at), history[2]!],
      true,
    ],
    ['a shorter history', history.slice(0, 2), true],
    [
      'a compaction summary',
      [
        ...history,
        msg('assistant', 'Summary…', '2026-10-05T10:05:00.000Z', {
          synthetic: 'compaction-summary',
        }),
      ],
      true,
    ],
    [
      'an aborted reply after an end-of-turn checkpoint',
      [...history, msg('assistant', '', '2026-10-05T10:05:00.000Z', { synthetic: 'turn-aborted' })],
      false,
    ],
  ])('declines %s', (_label, messages, inTurn) => {
    const restored = restoreFromWireTranscript(checkpoint(history, inTurn as boolean), {
      providerName: 'mlx',
      messages: messages as ChatMessage[],
    });
    expect(restored.ok).toBe(false);
  });

  it('declines a checkpoint from another provider, and the absence of one', () => {
    expect(
      restoreFromWireTranscript(checkpoint(history, true), {
        providerName: 'llama-cpp',
        messages: history,
      }).ok,
    ).toBe(false);
    expect(restoreFromWireTranscript(null, { providerName: 'mlx', messages: history })).toEqual({
      ok: false,
      reason: 'no checkpoint',
    });
  });
});

describe('wireTranscriptIsPaired', () => {
  it('accepts answered calls and rejects open ones', () => {
    expect(wireTranscriptIsPaired(transcript)).toBe(true);
    expect(wireTranscriptIsPaired(transcript.slice(0, -1))).toBe(false);
    expect(
      wireTranscriptIsPaired([
        ...transcript.slice(0, 2),
        { role: 'user', content: 'interrupting' },
      ]),
    ).toBe(false);
    expect(wireTranscriptIsPaired([{ role: 'tool', content: 'stray', toolCallId: 'x' }])).toBe(
      false,
    );
  });
});

describe('the MLX transcript round trip', () => {
  it('a session seeded with a transcript reproduces it exactly', async () => {
    const provider = new MlxProvider({ baseUrl: 'http://engine.test' });
    const session = await provider.createSession({
      systemMessage: 'system',
      priorMessages: transcript,
    });
    try {
      expect(session.getWireTranscript?.()).toEqual(transcript);
    } finally {
      await session.disconnect();
    }
  });

  it('declines what cannot round-trip', () => {
    expect(
      mlxWireTranscript([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'look', images: ['iVBOR…'] },
      ]),
    ).toBeUndefined();
    expect(
      mlxWireTranscript([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'late band' },
      ]),
    ).toBeUndefined();
    // Leading system bands (stable + volatile) are not transcript.
    expect(
      mlxWireTranscript([
        { role: 'system', content: 'stable' },
        { role: 'system', content: 'volatile' },
        { role: 'user', content: 'hi' },
      ]),
    ).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
