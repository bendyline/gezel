import { describe, expect, it, vi } from 'vitest';
import { nativeToolSpecs } from '../tools/native-tools.js';
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

describe('native tool calling', () => {
  async function runNative(
    generate: PortableInference['generate'],
    listing?: PortableToolListing,
    narrowed?: (listing: PortableToolListing) => void,
  ) {
    const { store, session, inventory } = await fixture();
    const checkpoint = vi.fn(async () => {});
    const tool = vi.fn();
    const result = runPortableToolLoop({
      store,
      session,
      inference: { providers: async () => [], generate, cancel: async () => {} },
      requestId: 'req',
      providerId: 'apple-foundation-models',
      modelId: 'apple-foundation-models',
      contextSize: 4096,
      maxTokens: 1024,
      nativeTools: { teamScope: false },
      messages: [
        { role: 'system', content: 'Reply briefly.' },
        { role: 'user', content: 'Write the note.' },
      ],
      tools: { inventory, listing, narrowed },
      actions: { ...actions, askQuestion: async () => ({ questionId: 'q-1' }) },
      cancelled: () => false,
      checkpoint,
      tool,
      delta: () => {},
    });
    return { store, result, checkpoint, tool };
  }

  it("runs the provider's own calls through the shared call path", async () => {
    const outputs: string[] = [];
    const generate = vi.fn<PortableInference['generate']>(async (request, _onDelta, onToolCall) => {
      expect(request.tools?.some(({ name }) => name === 'write_artifact')).toBe(true);
      expect(request.messages[0]!.content).not.toContain('"parameters"');
      expect(request.messages[0]!.content).toContain('Most messages need no tool');
      const reply = await onToolCall!({
        requestId: 'req',
        callId: 'c1',
        name: 'write_artifact',
        arguments: JSON.stringify({ path: 'note.md', content: 'Noor opens at 09:30.' }),
      });
      outputs.push(reply.output);
      expect(reply.endTurn).toBeFalsy();
      return { text: 'Saved note.md.', stopReason: 'stop' };
    });
    const { store, result, checkpoint, tool } = await runNative(generate);
    const done = await result;
    expect(done.text).toBe('Saved note.md.');
    expect(done.message?.toolCalls?.[0]).toMatchObject({ name: 'write_artifact', success: true });
    expect(outputs[0]).toMatch(/^Tool result for write_artifact \(reference data\):/);
    expect(await store.readFile('artifacts', 'default', 'note.md')).toBe('Noor opens at 09:30.');
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(tool).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });

  it('ends the turn after a call that waits on the user', async () => {
    const generate = vi.fn<PortableInference['generate']>(
      async (_request, _onDelta, onToolCall) => {
        const reply = await onToolCall!({
          requestId: 'req',
          callId: 'c1',
          name: 'ask_user_question',
          arguments: JSON.stringify({ question: 'Which colour should the poster be?' }),
        });
        expect(reply).toEqual({ output: '', endTurn: true });
        // The native host stops generation once told the turn ended.
        return { text: '', stopReason: 'stop' };
      },
    );
    const { result } = await runNative(generate);
    const done = await result;
    expect(done).toMatchObject({ text: '', stopReason: 'stop' });
    expect(done.message?.pendingQuestionId).toBe('q-1');
  });

  it('narrows native tools before generating: descriptions, then the core kit, then none', async () => {
    const seen: Array<{ tools: number; described: boolean; none: boolean }> = [];
    const generate = vi.fn<PortableInference['generate']>(async (request, _onDelta, onToolCall) => {
      seen.push({
        tools: request.tools?.length ?? 0,
        described: !!request.tools?.some(({ parameters }) =>
          parameters.properties.some(({ schema }) => schema.description),
        ),
        none: request.messages[0]!.content.includes('None: the tool list does not fit'),
      });
      if (request.tools)
        throw Object.assign(new Error('Budget refused'), { code: 'CONTEXT_LIMIT' });
      expect(onToolCall).toBeUndefined();
      return { text: 'Done.', stopReason: 'stop' };
    });
    const narrowed = vi.fn();
    const { result } = await runNative(generate, undefined, narrowed);
    expect(await result).toMatchObject({ text: 'Done.' });
    expect(narrowed.mock.calls.map(([listing]) => listing)).toEqual(['compact', 'core', 'none']);
    expect(seen[0]!.described).toBe(true);
    expect(seen[1]!.described).toBe(false);
    expect(seen[1]!.tools).toBe(seen[0]!.tools);
    expect(seen[2]!.tools).toBeLessThan(seen[1]!.tools);
    expect(seen[2]!.tools).toBeGreaterThan(0);
    expect(seen[3]).toEqual({ tools: 0, described: false, none: true });
  });

  it('never retries a refusal once a native call has committed its effect', async () => {
    const generate = vi.fn<PortableInference['generate']>(
      async (_request, _onDelta, onToolCall) => {
        await onToolCall!({
          requestId: 'req',
          callId: 'c1',
          name: 'write_artifact',
          arguments: JSON.stringify({ path: 'once.md', content: 'Written once.' }),
        });
        throw Object.assign(new Error('Budget refused'), { code: 'CONTEXT_LIMIT' });
      },
    );
    const { store, result } = await runNative(generate);
    await expect(result).rejects.toThrow('Budget refused');
    expect(generate).toHaveBeenCalledOnce();
    expect(await store.readFile('artifacts', 'default', 'once.md')).toBe('Written once.');
  });

  it('hides the session project and the step tools outside a task, and drops a stray project', async () => {
    const { inventory } = await fixture();
    const specs = nativeToolSpecs(inventory, 'full', { teamScope: false });
    expect(inventory.some(({ name }) => name === 'write_artifact')).toBe(true);
    expect(specs.map(({ name }) => name)).not.toContain('advance_task_step');
    expect(specs.map(({ name }) => name)).not.toContain('write_task_note');
    for (const spec of specs)
      expect(
        spec.parameters.properties.map(({ name }) => name),
        spec.name,
      ).not.toContain('project');
    const generate = vi.fn<PortableInference['generate']>(
      async (_request, _onDelta, onToolCall) => {
        await onToolCall!({
          requestId: 'req',
          callId: 'c1',
          name: 'write_artifact',
          arguments: JSON.stringify({
            project: 'eval craftsperson',
            path: 'p.md',
            content: 'In scope.',
          }),
        });
        return { text: 'Saved.', stopReason: 'stop' };
      },
    );
    const { store, result } = await runNative(generate);
    expect((await result).message?.toolCalls?.[0]).toMatchObject({ success: true });
    expect(await store.readFile('artifacts', 'default', 'p.md')).toBe('In scope.');
  });

  it('fills the task and step a task session is bound to', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const gezel = await store.createGezel({ name: 'Native tester', role: 'Generalist' });
    const created = await store.createTask('default', {
      title: 'Finish task',
      description: 'Finish this single-step task for the native binding test.',
      assignee: { kind: 'gezel', gezelId: gezel.id },
      steps: [{ name: 'Finish', terminal: true }],
    });
    await store.setTaskStatus(created.ref, 'active');
    const task = (await store.getTask(created.ref))!;
    const session = await store.createSession({
      gezelId: gezel.id,
      providerName: 'apple-foundation-models',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
    const inventory = await portableToolSurface(store, session);
    const binding = { teamScope: false, taskRef: task.ref, stepId: task.activeStepId };
    const advance = nativeToolSpecs(inventory, 'full', binding).find(
      ({ name }) => name === 'advance_task_step',
    );
    expect(advance?.parameters.properties.map(({ name }) => name)).not.toContain('ref');
    expect(advance?.parameters.properties.map(({ name }) => name)).not.toContain('stepId');
    const generate = vi.fn<PortableInference['generate']>(
      async (_request, _onDelta, onToolCall) => {
        const reply = await onToolCall!({
          requestId: 'req',
          callId: 'c1',
          name: 'advance_task_step',
          arguments: JSON.stringify({ ref: 'tasks/1/', stepId: 'wrong' }),
        });
        expect(reply.endTurn).toBe(true);
        return { text: '', stopReason: 'stop' };
      },
    );
    const result = await runPortableToolLoop({
      store,
      session,
      inference: { providers: async () => [], generate, cancel: async () => {} },
      requestId: 'req',
      providerId: 'apple-foundation-models',
      modelId: 'apple-foundation-models',
      contextSize: 4096,
      maxTokens: 1024,
      nativeTools: binding,
      messages: [{ role: 'user', content: 'Finish the step.' }],
      tools: { inventory },
      actions: {
        ...actions,
        completeTask: (ref) => store.completeTaskStep(ref, task.activeStepId!),
      },
      cancelled: () => false,
      checkpoint: async () => {},
      tool: () => {},
      delta: () => {},
    });
    expect(result.text).toBe('The task is complete.');
    expect((await store.getTask(task.ref))?.status).toBe('complete');
  });

  it("caps each tool result to a share of the model's window", async () => {
    let output = '';
    const generate = vi.fn<PortableInference['generate']>(
      async (_request, _onDelta, onToolCall) => {
        output = (
          await onToolCall!({
            requestId: 'req',
            callId: 'c1',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'big.md' }),
          })
        ).output;
        return { text: 'Read.', stopReason: 'stop' };
      },
    );
    const { store } = portableFixture();
    await store.ensureLayout();
    await store.writeFile('workspace', 'default', 'big.md', 'x'.repeat(10_000));
    const gezel = await store.createGezel({ name: 'Native tester', role: 'Helper' });
    const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
    await runPortableToolLoop({
      store,
      session,
      inference: { providers: async () => [], generate, cancel: async () => {} },
      requestId: 'req',
      providerId: 'apple-foundation-models',
      modelId: 'apple-foundation-models',
      contextSize: 4096,
      maxTokens: 1024,
      nativeTools: { teamScope: false },
      messages: [{ role: 'user', content: 'Read big.md.' }],
      tools: { inventory: await portableToolSurface(store, session) },
      actions,
      cancelled: () => false,
      checkpoint: async () => {},
      tool: () => {},
      delta: () => {},
    });
    expect(output).toContain('[Result truncated; narrow the next request.]');
    expect(output.length).toBeLessThan(4096 + 200);
  });

  it('ends the turn when the same call keeps failing the same way', async () => {
    const replies: Array<{ output: string; endTurn?: boolean }> = [];
    const generate = vi.fn<PortableInference['generate']>(
      async (_request, _onDelta, onToolCall) => {
        for (const order of [0, 1, 2]) {
          const reply = await onToolCall!({
            requestId: 'req',
            callId: `c${order}`,
            name: 'read_file',
            arguments: JSON.stringify({ path: 'missing.md' }),
          });
          replies.push(reply);
          if (reply.endTurn) break;
        }
        return { text: '', stopReason: 'stop' };
      },
    );
    const { result } = await runNative(generate);
    const done = await result;
    expect(replies.map(({ endTurn }) => !!endTurn)).toEqual([false, false, true]);
    expect(done.text).toMatch(/^Stopped: the same read_file call failed three times/);
    expect(done.message?.toolCalls).toHaveLength(3);
  });

  it('stops at the action limit', async () => {
    const generate = vi.fn<PortableInference['generate']>(
      async (_request, _onDelta, onToolCall) => {
        for (let call = 0; call < 9; call++)
          await onToolCall!({
            requestId: 'req',
            callId: `c${call}`,
            name: 'list_dir',
            arguments: '{}',
          });
        return { text: 'Never reached.', stopReason: 'stop' };
      },
    );
    const { result } = await runNative(generate);
    await expect(result).rejects.toThrow('This turn reached its action limit');
  });
});
