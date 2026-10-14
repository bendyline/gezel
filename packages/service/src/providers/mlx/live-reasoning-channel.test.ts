import { MlxProvider } from '@bendyline/gezel-inference/internal/providers/mlx/provider';
import { describe, expect, it, vi } from 'vitest';

// `gezel run` prints only the visible delta channel. With MLX it printed the
// models' thoughts: Qwen 3.5 0.8B's template opens `<think>` only when thinking
// is explicitly on, so the template guess said "closed", and Gemma 4's thought
// channel was not a marker the live split knew (npm audit, 2026-10-13).

function stream(chunks: string[], reasoningOpen?: '0' | '1'): Response {
  const frames = chunks.map(
    (content) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
  );
  frames.push(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  );
  const headers: Record<string, string> = { 'content-type': 'text/event-stream' };
  if (reasoningOpen) headers['x-gezel-reasoning-open'] = reasoningOpen;
  return new Response(frames.join(''), { headers });
}

async function turn(
  response: Response,
  opts: {
    family: 'qwen' | 'gemma';
    reasoningFormat: 'think' | 'channel';
    templateOpensReasoning?: 'always' | 'unless-thinking-off';
  },
): Promise<{ visible: string; reasoning: string; reply: string }> {
  const provider = new MlxProvider({
    baseUrl: 'http://engine.test',
    fetchImpl: vi.fn().mockResolvedValue(response) as unknown as typeof fetch,
    ...(opts.templateOpensReasoning ? { templateOpensReasoning: opts.templateOpensReasoning } : {}),
  });
  const session = await provider.createSession({
    systemMessage: 'Be brief.',
    profile: {
      catalogId: 'test-model',
      tier: 'small',
      style: {
        family: opts.family,
        reasoningFormat: opts.reasoningFormat,
        toolCallFormat: 'function-call',
      },
      behaviors: [],
    },
  });
  let visible = '';
  let reasoning = '';
  session.onDelta((chunk) => {
    visible += chunk;
  });
  session.onReasoningDelta?.((chunk) => {
    reasoning += chunk;
  });
  try {
    const reply = await session.sendAndWait('Say hello.');
    return { visible, reasoning, reply };
  } finally {
    await session.disconnect();
  }
}

describe('MLX live reasoning channel', () => {
  it('trusts the engine when the template guess says the prompt opened nothing', async () => {
    const out = await turn(
      stream(['The user wants a ', 'greeting.\n', '</think>', '\n\nHello!'], '1'),
      { family: 'qwen', reasoningFormat: 'think' },
    );
    expect(out.visible).toBe('Hello!');
    expect(out.reasoning).toBe('The user wants a greeting.\n');
    expect(out.reply).toBe('Hello!');
  });

  it("keeps Gemma's thought channel off the visible stream", async () => {
    const out = await turn(
      stream(['<|channel>', 'thought\n', 'A greeting is wanted.', '<channel|>', 'Hello!'], '0'),
      { family: 'gemma', reasoningFormat: 'channel' },
    );
    expect(out.visible).toBe('Hello!');
    expect(out.reasoning).toBe('A greeting is wanted.');
    expect(out.reply).toBe('Hello!');
  });

  it('a reported closed prompt overrides a template that would open', async () => {
    const out = await turn(stream(['Hello!'], '0'), {
      family: 'qwen',
      reasoningFormat: 'think',
      templateOpensReasoning: 'always',
    });
    expect(out.visible).toBe('Hello!');
    expect(out.reasoning).toBe('');
  });

  it('falls back to the template without the header', async () => {
    const out = await turn(stream(['Weighing it.', '</think>', 'Hello!']), {
      family: 'qwen',
      reasoningFormat: 'think',
      templateOpensReasoning: 'unless-thinking-off',
    });
    expect(out.visible).toBe('Hello!');
    expect(out.reasoning).toBe('Weighing it.');
  });
});
