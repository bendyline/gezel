import { describe, expect, it, vi } from 'vitest';
import type { PortableInference } from './product-service.js';
import { type PortableToolActions, portableToolSurface } from './product-tools.js';
import { portableFixture } from './test-files.js';
import {
  type PortableToolListing,
  type PortableToolSpec,
  runPortableToolLoop,
  toolProtocol,
} from './tool-loop.js';

const actions: PortableToolActions = {
  recruit: async () => {
    throw new Error('unexpected recruitment');
  },
  templates: () => [],
  createTask: async () => {},
  completeTask: async () => {},
  assertHandoffAllowed: () => {},
  message: async () => {},
  startProject: async () => {},
};
const LLAMA_OVERFLOW =
  'Prompt plus requested output exceeds the context; shorten the transcript or output';

async function fixture() {
  const { store } = portableFixture();
  await store.ensureLayout();
  const gezel = await store.createGezel({ name: 'Native tester', role: 'Helper' });
  const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
  const inventory = await portableToolSurface(store, session);
  return { store, session, inventory };
}

/** The iOS bridge fixture's tokenizer spends one token per UTF-8 byte. */
function byteTokenizer() {
  const systems: string[] = [];
  const generate = vi.fn<PortableInference['generate']>(async (request) => {
    systems.push(request.messages[0]?.content ?? '');
    let tokens = 0;
    for (const message of request.messages)
      tokens += new TextEncoder().encode(message.content).byteLength;
    if (tokens + request.maxTokens! > request.contextSize!) throw new Error(LLAMA_OVERFLOW);
    return { text: 'Done.', stopReason: 'stop' };
  });
  return { generate, systems };
}

async function run(
  generate: PortableInference['generate'],
  tools: {
    inventory: readonly PortableToolSpec[];
    listing?: PortableToolListing;
    narrowed?(listing: PortableToolListing): void;
  },
) {
  const { store, session } = await fixture();
  return runPortableToolLoop({
    store,
    session,
    inference: { providers: async () => [], generate, cancel: async () => {} },
    requestId: 'req',
    providerId: 'llama-cpp',
    modelId: 'fixture',
    contextSize: 8192,
    maxTokens: 256,
    messages: [
      { role: 'system', content: 'Reply briefly.' },
      { role: 'user', content: 'Say hello.' },
    ],
    tools,
    actions,
    cancelled: () => false,
    checkpoint: async () => {},
    tool: () => {},
    delta: () => {},
  });
}

describe('portable tool listing', () => {
  it('keeps the full listing as the JSON inventory the protocol has always sent', async () => {
    const { inventory } = await fixture();
    const block = toolProtocol(inventory);
    expect(block.startsWith('## Tools available this turn\nTo act, return ONLY one JSON')).toBe(
      true,
    );
    expect(block.endsWith(`\n${JSON.stringify(inventory)}`)).toBe(true);
  });

  it('renders signatures with required, optional, enum, union, array and nested arguments', () => {
    const spec: PortableToolSpec = {
      name: 'plan_work',
      description: 'Plan the work. Everything after the first sentence is dropped.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Never rendered' },
          scope: { type: 'string', enum: ['gezel', 'project'] },
          occurrence: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['all'] }] },
          tags: { type: 'array', items: { type: 'string' } },
          owner: {
            oneOf: [
              {
                type: 'object',
                properties: { kind: { type: 'string', enum: ['gezel'] }, id: { type: 'string' } },
                required: ['kind', 'id'],
              },
              { type: 'object', properties: { kind: { type: 'string', enum: ['user'] } } },
            ],
          },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, meta: { type: 'object', properties: {} } },
              required: ['name'],
            },
          },
        },
        required: ['title', 'scope'],
      },
    };
    const signature =
      '- plan_work(title: string, scope: "gezel"|"project", occurrence?: integer|"all", tags?: string[], owner?: {kind: "gezel", id: string}|{kind?: "user"}, steps?: {name: string, meta?: object}[])';
    expect(toolProtocol([spec], 'compact').split('\n').at(-1)).toBe(`${signature}: Plan the work.`);
    expect(toolProtocol([spec], 'signatures').split('\n').at(-1)).toBe(signature);
  });

  it('shrinks at every step and lists no tool once none fit', async () => {
    const { inventory } = await fixture();
    const sizes = (['full', 'compact', 'signatures', 'none'] as const).map(
      (listing) => toolProtocol(inventory, listing).length,
    );
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(new Set(sizes).size).toBe(4);
    const none = toolProtocol(inventory, 'none');
    for (const tool of inventory) expect(none).not.toContain(tool.name);
  });
});

describe('fitting the tool listing to the provider context', () => {
  it('retries a refused prompt with a smaller listing until the provider accepts it', async () => {
    const { inventory } = await fixture();
    const { generate, systems } = byteTokenizer();
    const narrowed = vi.fn();
    const result = await run(generate, { inventory, narrowed });
    expect(result).toMatchObject({ text: 'Done.', stopReason: 'stop' });
    expect(systems[0]).toContain('"parameters"');
    expect(systems.at(-1)).toContain('- read_file(path: string');
    expect(systems.at(-1)!.startsWith('Reply briefly.\n\n## Tools available this turn')).toBe(true);
    expect(narrowed.mock.calls.map(([listing]) => listing)).toEqual(['compact']);
  });

  it('starts from the listing the conversation last fitted', async () => {
    const { inventory } = await fixture();
    const { generate, systems } = byteTokenizer();
    await run(generate, { inventory, listing: 'compact' });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(systems[0]).toContain('- read_file(path: string');
  });

  it("narrows on Apple's CONTEXT_LIMIT code down to no listing at all", async () => {
    const { inventory } = await fixture();
    const narrowed = vi.fn();
    const generate = vi.fn<PortableInference['generate']>(async (request) => {
      if (!request.messages[0]!.content.includes('None: the tool list does not fit'))
        throw Object.assign(new Error('Budget refused'), { code: 'CONTEXT_LIMIT' });
      return { text: 'Done.', stopReason: 'stop' };
    });
    expect(await run(generate, { inventory, narrowed })).toMatchObject({ text: 'Done.' });
    expect(narrowed.mock.calls.map(([listing]) => listing)).toEqual([
      'compact',
      'signatures',
      'none',
    ]);
  });

  it('keeps a narrowing forced by the turn’s own tool results out of the conversation', async () => {
    const { inventory } = await fixture();
    const narrowed = vi.fn();
    let calls = 0;
    const generate = vi.fn<PortableInference['generate']>(async (request) => {
      if (++calls === 1)
        return { text: JSON.stringify({ name: 'list_dir', arguments: {} }), stopReason: 'stop' };
      if (request.messages[0]!.content.includes('"parameters"')) throw new Error(LLAMA_OVERFLOW);
      return { text: 'Done.', stopReason: 'stop' };
    });
    expect(await run(generate, { inventory, narrowed })).toMatchObject({ text: 'Done.' });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(narrowed).not.toHaveBeenCalled();
  });

  it('reports the refusal when even no listing fits', async () => {
    const { inventory } = await fixture();
    const generate = vi.fn<PortableInference['generate']>(async () => {
      throw new Error(LLAMA_OVERFLOW);
    });
    await expect(run(generate, { inventory })).rejects.toThrow(LLAMA_OVERFLOW);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it('never retries after output streamed, or for a failure other than fit', async () => {
    const { inventory } = await fixture();
    const streamed = vi.fn<PortableInference['generate']>(async (request, onDelta) => {
      onDelta({ requestId: request.requestId, delta: 'Partial' });
      throw new Error(LLAMA_OVERFLOW);
    });
    await expect(run(streamed, { inventory })).rejects.toThrow(LLAMA_OVERFLOW);
    expect(streamed).toHaveBeenCalledTimes(1);
    const missing = vi.fn<PortableInference['generate']>(async () => {
      throw new Error('The model file is missing');
    });
    await expect(run(missing, { inventory })).rejects.toThrow('missing');
    expect(missing).toHaveBeenCalledTimes(1);
  });
});
