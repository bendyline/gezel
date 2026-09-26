import { describe, expect, it, vi } from 'vitest';
import { ProviderQueue } from '../queue.js';
import {
  AppleFmError,
  type AppleFmGenerateHandlers,
  type AppleFmGenerateRequest,
} from './helper.js';
import { AppleFoundationModelsProvider, AppleFoundationSession } from './provider.js';

const readFile = {
  type: 'function' as const,
  name: 'read_file',
  description: 'Read a file from the workspace. Paths are relative to the project root.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace path.' } },
    required: ['path'],
  },
};
const writeArtifact = {
  type: 'function' as const,
  name: 'write_artifact',
  description: 'Write a file into the project artifacts. Overwrites existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      meta: { type: 'object', additionalProperties: {} },
    },
    required: ['path', 'content'],
  },
};
const createTask = {
  type: 'function' as const,
  name: 'create_task',
  description: 'Create a task.',
  parameters: { type: 'object', properties: { title: { type: 'string' } } },
};

function bridges(callToolRich = vi.fn(async () => ({ text: 'ok', images: [], isError: false }))) {
  const tools = [readFile, writeArtifact, createTask];
  return {
    pool: {
      isEmpty: () => false,
      getOpenAITools: () => tools,
      hasTool: (name: string) => tools.some((tool) => tool.name === name),
      callToolRich,
      stop: vi.fn(async () => {}),
    },
    callToolRich,
  };
}

type Script = (
  request: AppleFmGenerateRequest,
  handlers: AppleFmGenerateHandlers,
) => Promise<'stop' | 'length' | 'cancelled'>;

function session(
  script: Script,
  opts: { history?: Array<{ role: 'user' | 'assistant'; content: string }> } = {},
) {
  const requests: AppleFmGenerateRequest[] = [];
  const helper = {
    generate: vi.fn(async (request: AppleFmGenerateRequest, handlers: AppleFmGenerateHandlers) => {
      requests.push(structuredClone(request));
      return script(request, handlers);
    }),
    countTokens: vi.fn(async () => 321),
  };
  const { pool, callToolRich } = bridges();
  const s = new AppleFoundationSession({
    helper: helper as never,
    queue: new ProviderQueue({ concurrency: 1 }),
    bridges: pool as never,
    systemMessage: 'You are Tamsin.',
    history: opts.history ?? [],
    contextTokens: 4096,
    maxTokens: 1024,
  });
  return { s, helper, requests, callToolRich };
}

describe('Apple on-device sessions', () => {
  it('runs native tool calls through the MCP bridge with decoded arguments', async () => {
    const { s, requests, callToolRich } = session(async (request, handlers) => {
      expect(request.tools?.map(({ name }) => name)).toEqual([
        'read_file',
        'write_artifact',
        'create_task',
      ]);
      const reply = await handlers.onToolCall({
        callId: 'k1',
        name: 'write_artifact',
        arguments: JSON.stringify({ path: 'note.md', content: 'Hi', meta: '{"tag":"x"}' }),
      });
      expect(reply).toEqual({ output: 'ok' });
      handlers.onDelta('Saved note.md.');
      return 'stop';
    });
    const usage = vi.fn();
    s.onUsage(usage);
    await expect(s.sendAndWait('Write a note')).resolves.toBe('Saved note.md.');
    expect(callToolRich).toHaveBeenCalledWith(
      'write_artifact',
      { path: 'note.md', content: 'Hi', meta: { tag: 'x' } },
      expect.objectContaining({ numCtxTokens: 4096 }),
    );
    expect(requests[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'Write a note' });
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 321, contextUtilization: { used: 321, limit: 4096 } }),
    );
    // The next turn carries this exchange as history.
    await s.sendAndWait('Thanks');
    expect(requests[1]!.messages.slice(1, 3)).toEqual([
      { role: 'user', content: 'Write a note' },
      { role: 'assistant', content: 'Saved note.md.' },
    ]);
  });

  it('narrows tools, then drops the oldest history, before giving up on a prompt that does not fit', async () => {
    const warnings: string[] = [];
    const { s, requests } = session(
      async (request) => {
        const described = request.tools?.some(({ description }) =>
          description.includes('Paths are'),
        );
        if (request.tools?.length && described) throw new AppleFmError('CONTEXT_LIMIT', 'too big');
        if ((request.tools?.length ?? 0) > 2) throw new AppleFmError('CONTEXT_LIMIT', 'too big');
        if (request.messages.length > 3) throw new AppleFmError('CONTEXT_LIMIT', 'too big');
        return 'stop';
      },
      {
        history: [
          { role: 'user', content: 'old question' },
          { role: 'assistant', content: 'old answer' },
          { role: 'user', content: 'recent question' },
          { role: 'assistant', content: 'recent answer' },
        ],
      },
    );
    s.onWarning((message) => warnings.push(message));
    await s.sendAndWait('Now this');
    const shapes = requests.map((r) => ({
      tools: r.tools?.map(({ name }) => name) ?? [],
      messages: r.messages.length,
    }));
    expect(shapes).toEqual([
      { tools: ['read_file', 'write_artifact', 'create_task'], messages: 6 },
      { tools: ['read_file', 'write_artifact', 'create_task'], messages: 6 },
      { tools: ['read_file', 'write_artifact'], messages: 6 },
      { tools: ['read_file', 'write_artifact'], messages: 4 },
      { tools: ['read_file', 'write_artifact'], messages: 2 },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it('never retries a refusal after a tool call ran', async () => {
    const { s, helper } = session(async (_request, handlers) => {
      await handlers.onToolCall({ callId: 'k1', name: 'read_file', arguments: '{"path":"a.md"}' });
      throw new AppleFmError('CONTEXT_LIMIT', 'too big');
    });
    await expect(s.sendAndWait('Read a.md')).rejects.toThrow('too big');
    expect(helper.generate).toHaveBeenCalledTimes(1);
  });

  it('ends the turn when the same call keeps failing the same way', async () => {
    const { s, callToolRich } = session(async (_request, handlers) => {
      for (let call = 0; call < 5; call++) {
        const reply = await handlers.onToolCall({
          callId: `k${call}`,
          name: 'read_file',
          arguments: '{"path":"missing.md"}',
        });
        if (reply.endTurn) break;
      }
      return 'stop';
    });
    callToolRich.mockResolvedValue({ text: 'ERROR: not found', images: [], isError: true });
    await expect(s.sendAndWait('Read it')).resolves.toMatch(
      /^Stopped: the same read_file call failed three times/,
    );
    expect(callToolRich).toHaveBeenCalledTimes(3);
  });
});

describe('Apple on-device provider', () => {
  it('explains why it cannot start instead of pointing at credentials', async () => {
    await expect(
      new AppleFoundationModelsProvider({ platform: 'linux', arch: 'x64' }).initialize(),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Apple silicon'),
      isActionable: true,
    });
    await expect(
      new AppleFoundationModelsProvider({
        platform: 'darwin',
        arch: 'arm64',
        binaryPath: '',
      }).initialize(),
    ).rejects.toMatchObject({
      message: expect.stringContaining('helper is missing'),
      isActionable: true,
    });
    const unavailable = {
      ready: async () => ({
        version: '1',
        os: 'Version 26.6',
        available: false,
        reason: 'Enable Apple Intelligence in Settings to use Apple on-device AI.',
        contextTokens: 4096,
        maxOutputTokens: 1024,
      }),
    };
    await expect(
      new AppleFoundationModelsProvider({
        helper: unavailable as never,
        platform: 'darwin',
        arch: 'arm64',
      }).initialize(),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Enable Apple Intelligence'),
      isActionable: true,
    });
  });

  it('lists the one system model with the window the OS reports', async () => {
    const helper = {
      ready: async () => ({
        version: '1',
        os: 'Version 27.0',
        available: true,
        contextTokens: 8192,
        maxOutputTokens: 1024,
      }),
    };
    const provider = new AppleFoundationModelsProvider({
      helper: helper as never,
      platform: 'darwin',
      arch: 'arm64',
    });
    await expect(provider.listModels()).resolves.toEqual([
      {
        id: 'apple-foundation-models',
        name: 'Apple on-device model',
        contextWindow: 8192,
        supportsTools: true,
      },
    ]);
    expect(provider.getContextWindow()).toBe(8192);
  });
});
