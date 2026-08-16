import type { ChatMessageToolCall, ProviderName } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../types.js';
import { PromptLibraryRecallPrelude } from './prompt-library-recall-prelude.js';

function turnCtx(overrides: Partial<TurnCtx>): TurnCtx {
  return {
    catalogId: 'mistral-7b',
    tier: 'small',
    family: 'mistral',
    modelId: 'mistral-7b',
    providerName: 'ollama' satisfies ProviderName,
    sessionId: 'sess-1',
    isMeester: false,
    projectId: 'default',
    messageOrigin: 'direct-user',
    availableToolNames: ['read_document'],
    userText: '',
    drained: [] as ChatMessageToolCall[],
    assistantContent: '',
    continuationCount: 0,
    ...overrides,
  };
}

const hook = (ctx: TurnCtx) => PromptLibraryRecallPrelude.userPromptPrelude?.(ctx, undefined);

describe('prompt.library-recall-prelude', () => {
  it('is silent when the turn matched no documents', () => {
    // The overwhelmingly common case. Silence here is what makes a
    // per-turn retrieval mechanism affordable at all.
    expect(hook(turnCtx({ userText: 'how is the sprint going?' }))).toBeNull();
    expect(hook(turnCtx({ libraryRecall: [] }))).toBeNull();
  });

  it('offers the matched documents and names the tool to open them', () => {
    const text = hook(
      turnCtx({
        userText: 'what is our refund window again?',
        libraryRecall: [
          {
            path: 'policies/refunds.md',
            snippet: 'Refunds  are\n issued within 30 days.',
            score: 0.8,
          },
        ],
      }),
    );
    expect(text).toContain('policies/refunds.md');
    // Whitespace from the source document is collapsed, not passed through.
    expect(text).toContain('Refunds are issued within 30 days.');
    expect(text).toContain('read_document');
    // Advisory, never an instruction: a retrieval hit is a guess at intent.
    expect(text).toContain('ignore them if not');
  });

  it('does not name a tool the turn does not have', () => {
    const text = hook(
      turnCtx({
        availableToolNames: [],
        libraryRecall: [{ path: 'brand/voice.md', snippet: 'Warm and plain.', score: 0.9 }],
      }),
    );
    expect(text).toContain('brand/voice.md');
    expect(text).not.toContain('read_document');
  });

  it('caps how much of a turn it will occupy', () => {
    const text = hook(
      turnCtx({
        libraryRecall: [
          { path: 'a.md', snippet: 'x'.repeat(400), score: 0.9 },
          { path: 'b.md', snippet: 'y'.repeat(400), score: 0.85 },
          { path: 'c.md', snippet: 'z'.repeat(400), score: 0.8 },
        ],
      }),
    );
    expect(text).toContain('a.md');
    expect(text).toContain('b.md');
    expect(text).not.toContain('c.md');
    expect(text!.length).toBeLessThan(500);
  });
});
