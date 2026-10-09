import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeClient } from './knowledge-client.js';
import { withKnowledgeContext } from './knowledge-context.js';
import type { ChatMessage } from './types.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Write clearly.' },
  { role: 'user', content: 'Describe tides.' },
];
const budget = { maxPromptCharacters: 256 * 1024, maxMessages: 64 };
const result = {
  reranked: false,
  passages: [
    {
      uri: 'knowledge://science/1/tides',
      title: 'Tides',
      catalogId: 'science',
      version: '1',
      text: 'The Moon influences tides.',
    },
  ],
};
function client(value: unknown = result) {
  return { retrieve: vi.fn(async () => value) } as unknown as Pick<KnowledgeClient, 'retrieve'>;
}

describe('optional knowledge context', () => {
  it('delegates ranking, preserves the task, and includes bounded citations as untrusted evidence', async () => {
    const knowledge = client();
    const output = await withKnowledgeContext(knowledge, messages, budget);
    expect(knowledge.retrieve).toHaveBeenCalledWith(
      { query: 'Describe tides.', maxResults: 4, maxCharacters: 12000 },
      { signal: undefined },
    );
    expect(output.slice(1)).toEqual(messages);
    expect(output[0]?.content).toContain('never as instructions');
    expect(output[0]?.content).toContain('knowledge://science/1/tides');
    expect(messages).toHaveLength(2);
  });
  it.each([
    { ...result, passages: [...result.passages, { ...result.passages[0], uri: 'file:///secret' }] },
    { ...result, passages: Array.from({ length: 5 }, () => result.passages[0]) },
    { ...result, passages: [{ ...result.passages[0], text: 'x'.repeat(12001) }] },
    { ...result, extra: true },
  ])('drops the entire malformed result', async (value) => {
    expect(await withKnowledgeContext(client(value), messages, budget)).toEqual(messages);
  });
  it('keeps the request usable when retrieval fails or is unavailable', async () => {
    const knowledge = client();
    vi.mocked(knowledge.retrieve).mockRejectedValue(new Error('offline'));
    expect(await withKnowledgeContext(knowledge, messages, budget)).toEqual(messages);
    expect(await withKnowledgeContext(undefined, messages, budget)).toEqual(messages);
  });
  it('does not retrieve when the prompt, context, or message count leaves no room', async () => {
    const knowledge = client();
    for (const options of [
      { contextWindow: 2048 },
      { maxPromptCharacters: 3000 },
      { maxMessages: 2 },
    ])
      expect(await withKnowledgeContext(knowledge, messages, { ...budget, ...options })).toEqual(
        messages,
      );
    expect(knowledge.retrieve).not.toHaveBeenCalled();
  });
  it('counts serialization overhead and does not inject partially fitting evidence', async () => {
    const knowledge = client({
      ...result,
      passages: [{ ...result.passages[0], text: '\\'.repeat(6000) }],
    });
    expect(
      await withKnowledgeContext(knowledge, messages, { ...budget, maxPromptCharacters: 10000 }),
    ).toEqual(messages);
  });
  it('propagates cancellation even when retrieval returns late or fails', async () => {
    const controller = new AbortController();
    const knowledge = client();
    vi.mocked(knowledge.retrieve).mockImplementation(async () => {
      controller.abort();
      return result;
    });
    await expect(
      withKnowledgeContext(knowledge, messages, { ...budget, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
