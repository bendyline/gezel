import { describe, expect, it } from 'vitest';
import type { ChatSession } from '../schemas/session.js';

type ChatMessage = ChatSession['messages'][number];
import { NEW_THREAD_TITLE } from '../thread-title.js';
import { sessionSummary } from './entities.js';

const at = '2026-04-14T10:00:00Z';
function session(messages: ChatMessage[], overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    version: 1,
    id: 'sess-a',
    gezelId: 'ada',
    projectId: 'default',
    providerName: 'copilot',
    model: 'mock-fast',
    title: 'Untitled',
    createdAt: at,
    lastActivityAt: at,
    messages,
    providerState: {},
    ...overrides,
  } as ChatSession;
}

describe('sessionSummary', () => {
  it('counts only plain user messages as human activity', () => {
    const summary = sessionSummary(
      session([
        { role: 'user', content: 'first', at: '2026-04-14T10:00:00Z' },
        {
          role: 'user',
          content: 'nudge',
          at: '2026-04-14T10:05:00Z',
          from: { gezelId: 'meester', gezelName: 'Meester' },
        },
      ]),
    );
    expect(summary.lastHumanActivityAt).toBe('2026-04-14T10:00:00Z');
    // The owner comes first; anyone who spoke through `from` follows.
    expect(summary.involvedGezelIds).toEqual(['ada', 'meester']);
  });

  it('previews the last message collapsed to one line and capped at 200 characters', () => {
    const long = `${'é'.repeat(150)}\n\n${'ü'.repeat(150)}`;
    const summary = sessionSummary(session([{ role: 'assistant', content: long, at }]));
    expect(summary.lastMessagePreview).not.toContain('\n');
    expect([...summary.lastMessagePreview!].length).toBeLessThanOrEqual(200);
  });

  it('tallies tool-call arguments and results into the transcript estimate', () => {
    const bare = sessionSummary(session([{ role: 'assistant', content: 'x', at }]));
    const withCalls = sessionSummary(
      session([
        {
          role: 'assistant',
          content: 'x',
          at,
          toolCalls: [
            { name: 'read_file', argsFull: 'a'.repeat(400), resultText: 'b'.repeat(400) },
          ],
        } as ChatMessage,
      ]),
    );
    expect(withCalls.transcriptTokens ?? 0).toBeGreaterThan((bare.transcriptTokens ?? 0) + 150);
  });

  it('derives a title from the sentinel only once a turn has completed', () => {
    const unfinished = sessionSummary(
      session([{ role: 'user', content: 'Plan the launch', at }], { title: NEW_THREAD_TITLE }),
    );
    expect(unfinished.title).toBe(NEW_THREAD_TITLE);
    const finished = sessionSummary(
      session(
        [
          { role: 'user', content: 'Plan the launch', at },
          { role: 'assistant', content: 'Here is a plan.', at },
        ],
        { title: NEW_THREAD_TITLE },
      ),
    );
    expect(finished.title).not.toBe(NEW_THREAD_TITLE);
  });
});
