import type { FileTurnIntent } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import type { LLMSession, SessionOpts } from '../types.js';
import { LlamaCppProvider } from './provider.js';

/**
 * The desktop llama.cpp turn loop, pinned byte for byte: every request body it
 * sends, every tool it runs, and what it returns and emits. The phone runs this
 * same loop over a native transport, so a change here is a change on both
 * hosts. Regenerate only when a behavior change is intended:
 * `vitest run -u src/providers/llama-cpp/wire-golden.test.ts`.
 */

type Delta = Record<string, unknown>;
type Step = { deltas: Delta[]; finish?: string };

const text = (content: string, finish = 'stop'): Step => ({ deltas: [{ content }], finish });
const call = (name: string, args: unknown, id = 'call-1'): Step => ({
  deltas: [
    {
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
        },
      ],
    },
  ],
  finish: 'tool_calls',
});

function sse(step: Step): Response {
  const frames = step.deltas.map(
    (delta, i) =>
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta,
            finish_reason: i === step.deltas.length - 1 ? (step.finish ?? 'stop') : null,
          },
        ],
      })}\n\n`,
  );
  return new Response(`${frames.join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a workspace text file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a workspace text file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'replace_in_file',
    description: 'Edit an existing workspace file with a literal find/replace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        find: { type: 'string' },
        replace: { type: 'string' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'list_dir',
    description: 'List workspace files.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// Salvaged call ids carry the wall clock (`json-envelope-repair-<ms>-0`).
const EPOCH_MS = /\b1[6-9]\d{11}\b/g;
function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(UUID, '<uuid>').replace(EPOCH_MS, '<ms>'));
}

const sessions: LLMSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

interface Scenario {
  name: string;
  prompt: string;
  steps: Step[];
  results?: (name: string, args: Record<string, unknown>, n: number) => string;
  fileTurnIntent?: FileTurnIntent;
  priorMessages?: SessionOpts['priorMessages'];
}

const SCENARIOS: Scenario[] = [
  { name: 'plain-reply', prompt: 'Say hello.', steps: [text('Hello there.')] },
  {
    name: 'read-then-answer',
    prompt: 'What does notes.md say?',
    steps: [call('read_file', { path: 'notes.md' }), text('It says: buy milk.')],
    results: () => 'buy milk',
  },
  {
    name: 'read-write-answer',
    prompt: 'Copy notes.md to copy.md.',
    steps: [
      call('read_file', { path: 'notes.md' }),
      call('write_file', { path: 'copy.md', content: 'buy milk' }, 'call-2'),
      text('Copied.'),
    ],
    results: (name) => (name === 'read_file' ? 'buy milk' : 'Wrote copy.md'),
  },
  {
    name: 'tool-error-then-retry',
    prompt: 'Write result.json with {"ok":true}.',
    steps: [
      call('write_file', { path: '/abs/result.json', content: '{"ok":true}' }),
      call('write_file', { path: 'result.json', content: '{"ok":true}' }, 'call-2'),
      text('Done.'),
    ],
    results: (_name, args) =>
      String(args.path).startsWith('/')
        ? 'ERROR: path must stay inside the workspace'
        : 'Wrote result.json',
  },
  {
    name: 'malformed-arguments-then-valid',
    prompt: 'Read notes.md.',
    steps: [
      call('read_file', '{"path": "notes.md"'),
      call('read_file', { path: 'notes.md' }, 'call-2'),
      text('Read it.'),
    ],
    results: () => 'buy milk',
  },
  {
    name: 'json-envelope-in-text',
    prompt: 'List the workspace.',
    steps: [text('{"name":"list_dir","arguments":{"path":"."}}'), text('Two files.')],
    results: () => 'a.md\nb.md',
  },
  {
    name: 'gemma-native-call-in-text',
    prompt: 'Read notes.md.',
    steps: [
      text('<|tool_call>call:read_file{path:<|"|>notes.md<|"|>}<tool_call|>'),
      text('It says buy milk.'),
    ],
    results: () => 'buy milk',
  },
  {
    name: 'prose-then-trailing-envelope',
    prompt: 'Write result.json with the total.',
    steps: [
      text(
        'The total is 28.\n\n{"name":"write_file","arguments":{"path":"result.json","content":"{\\"total\\":28}"}}',
      ),
      text('Saved.'),
    ],
    results: () => 'Wrote result.json',
  },
  {
    name: 'unknown-tool',
    prompt: 'Check the weather.',
    steps: [call('get_weather', { city: 'Oslo' }), text('I cannot check the weather.')],
  },
  {
    name: 'reasoning-stream',
    prompt: 'Think, then answer.',
    steps: [
      {
        deltas: [
          { reasoning_content: 'The user wants a short answer.' },
          { content: 'Forty-two.' },
        ],
        finish: 'stop',
      },
    ],
  },
  {
    name: 'length-finish',
    prompt: 'Write a long story.',
    steps: [text('Once upon a time there was', 'length')],
  },
  {
    name: 'create-file-stall-rescue',
    prompt: 'Please finish the requested work.',
    fileTurnIntent: { kind: 'create-file', path: 'reports/budget.rst' },
    steps: [
      text('I will do that.'),
      call('write_file', { path: 'reports/budget.rst', content: 'complete' }),
    ],
    results: () => 'Wrote reports/budget.rst',
  },
  {
    name: 'repair-file-read-then-patch',
    prompt: 'The validator found an issue; please address it.',
    fileTurnIntent: { kind: 'repair-file', path: 'lib/payment.py', readPaths: ['lib/payment.py'] },
    steps: [
      call('read_file', { path: 'lib/payment.py' }),
      call('replace_in_file', { path: 'lib/payment.py', find: 'bad', replace: 'good' }, 'call-2'),
    ],
    results: (name) => (name === 'read_file' ? 'bad code' : 'Replaced 1 occurrence'),
  },
  {
    name: 'prior-tool-turns-replayed',
    prompt: 'And now summarize it.',
    priorMessages: [
      { role: 'user', content: 'Read notes.md.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'prior-1', name: 'read_file', arguments: '{"path":"notes.md"}' }],
      },
      { role: 'tool', content: 'buy milk', toolCallId: 'prior-1', toolName: 'read_file' },
      { role: 'assistant', content: 'It says buy milk.' },
    ] as unknown as SessionOpts['priorMessages'],
    steps: [text('Summary: buy milk.')],
  },
];

describe('llama.cpp desktop wire golden', () => {
  it.each(SCENARIOS)('$name', async (scenario) => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const step = scenario.steps[Math.min(bodies.length - 1, scenario.steps.length - 1)]!;
      return sse(step);
    };
    const provider = new LlamaCppProvider({
      baseUrl: 'http://engine.test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const session = await provider.createSession({
      systemMessage: 'You are a careful assistant.',
      ...(scenario.priorMessages ? { priorMessages: scenario.priorMessages } : {}),
    });
    sessions.push(session);
    const executed: Array<[string, unknown]> = [];
    (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => TOOLS,
      hasTool: (name: string) => TOOLS.some((tool) => tool.name === name),
      callTool: async (name: string, args: Record<string, unknown>) => {
        executed.push([name, args]);
        return scenario.results?.(name, args, executed.length) ?? 'ok';
      },
      stop: async () => {},
    };
    const deltas: string[] = [];
    const reasoning: string[] = [];
    const warnings: string[] = [];
    session.onDelta((chunk) => deltas.push(chunk));
    session.onReasoningDelta?.((chunk) => reasoning.push(chunk));
    session.onWarning?.((message) => warnings.push(message));
    let result: string | undefined;
    let error: string | undefined;
    try {
      result = await session.sendAndWait(scenario.prompt, {
        ...(scenario.fileTurnIntent ? { fileTurnIntent: scenario.fileTurnIntent } : {}),
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const record = normalize({
      requests: bodies,
      executed,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      deltas: deltas.join(''),
      reasoning: reasoning.join(''),
      warnings,
    });
    await expect(`${JSON.stringify(record, null, 2)}\n`).toMatchFileSnapshot(
      `./__golden__/wire/${scenario.name}.json`,
    );
  });
});
