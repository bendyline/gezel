import { turnCancelledMessage } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupBehavior } from '../../model-profile/registry.js';
import { GpuArbiter } from '../gpu-arbiter.js';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import { isSseComment, readSseEvents } from '../openai-compatible/sse.js';
import { LlamaCppCacheAdapter } from './cache-adapter.js';
import {
  LlamaCppProvider,
  NativeEngineCrashedError,
  ToolCallAccumulator,
  compactSuccessfulWriteToolCallForTranscript,
  completeWorkspaceReadPaths,
  constrainedToolNoSignalMsForModel,
  constrainedToolReasoningCharLimitForModel,
  extractPrerequisiteRepairReadPaths,
  flattenToolMessagesForStrictAlternation,
  hasInProgressFileRewritePayload,
  hasSalvageableImmediateFileWriteContent,
  hasSalvageableImmediateStructuredWriteArgs,
  isDirectFileWorkTurn,
  isExistingSourceEditTurn,
  isGateSurgicalEditTurn,
  isImmediateFileWriteTurn,
  isLlamaCppGrammarParseError,
  isRecoverableImmediateFileWriteError,
  isScenarioFileRepairTurn,
  llamaCppReasoningRequestDiagnostic,
  mergeSystemMessagesIntoFirst,
  normalizeJsonSchemaForLlamaCpp,
  normalizeMalformedStructuredToolCalls,
  runNodeScriptWrongTargetError,
  scenarioRepairTextAbortThreshold,
  shouldPreferScriptedDataFileWork,
  shouldStartScriptedDataFileWork,
  simplifyJsonSchemaForLlamaCpp,
  stripJsonSchemaPatternsForLlamaCpp,
  tryParseContextOverflow,
  tryParseStrictAlternationTemplateError,
  tryParseSystemMessageOrderingError,
  tryParseToolCallParseError,
  tryRepairMalformedWriteToolArguments,
} from './provider.js';

describe('llama.cpp reasoning request diagnostics', () => {
  it('reports only effective chat-template reasoning controls', () => {
    expect(
      llamaCppReasoningRequestDiagnostic({
        messages: [{ role: 'user', content: 'secret' }],
        chat_template_kwargs: {
          enable_thinking: true,
          reasoning_effort: 'xhigh',
          unrelated: 'ignored',
        },
      }),
    ).toEqual({ enableThinking: true, reasoningEffort: 'xhigh' });
    expect(llamaCppReasoningRequestDiagnostic({ messages: [] })).toBeNull();
  });
});

describe('llama.cpp JSON Schema compatibility', () => {
  it('normalizes RegExp.source slash escapes in nested URI patterns without mutating the source', () => {
    const schema = {
      type: 'object',
      properties: {
        source: {
          anyOf: [
            {
              type: 'object',
              properties: {
                uri: {
                  type: 'string',
                  pattern: '^docblocks:\\/\\/artifacts\\/[A-Za-z0-9][A-Za-z0-9._:-]*$',
                },
              },
            },
          ],
        },
        label: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
      },
    };

    const normalized = normalizeJsonSchemaForLlamaCpp(schema) as typeof schema;

    expect(normalized).not.toBe(schema);
    expect(normalized.properties.source.anyOf[0]!.properties.uri.pattern).toBe(
      '^docblocks://artifacts/[A-Za-z0-9][A-Za-z0-9._:-]*$',
    );
    expect(normalized.properties.label).toBe(schema.properties.label);
    expect(schema.properties.source.anyOf[0]!.properties.uri.pattern).toBe(
      '^docblocks:\\/\\/artifacts\\/[A-Za-z0-9][A-Za-z0-9._:-]*$',
    );
  });

  it('normalizes external tool schemas in the chat-completions request body', async () => {
    let capturedPattern: string | undefined;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        tools?: Array<{
          function: { parameters?: { properties?: { uri?: { pattern?: string } } } };
        }>;
      };
      capturedPattern = body.tools?.[0]?.function.parameters?.properties?.uri?.pattern;
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' } }] }, '[DONE]']);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'qwen',
      externalTools: [
        {
          name: 'read_artifact',
          parameters: {
            type: 'object',
            properties: {
              uri: { type: 'string', pattern: '^scheme:\\/\\/artifacts\\/[A-Za-z0-9]+$' },
            },
          },
        },
      ],
    });

    await expect(session.sendAndWait('read it')).resolves.toBe('ok');
    expect(capturedPattern).toBe('^scheme://artifacts/[A-Za-z0-9]+$');
  });

  it('retries a rejected tool grammar once without pattern constraints', async () => {
    const bodies: Array<{
      tools?: Array<{
        function: { parameters?: { properties?: { uri?: { pattern?: string } } } };
      }>;
    }> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number]);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: 'Failed to initialize samplers: failed to parse grammar',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, statusText: 'Bad Request' },
        );
      }
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'recovered' } }] }, '[DONE]']);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'qwen',
      externalTools: [
        {
          name: 'read_artifact',
          parameters: {
            type: 'object',
            properties: {
              uri: { type: 'string', pattern: '^scheme:\\/\\/artifacts\\/[A-Za-z0-9]+$' },
            },
          },
        },
      ],
    });

    await expect(session.sendAndWait('read it')).resolves.toBe('recovered');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.tools?.[0]?.function.parameters?.properties?.uri?.pattern).toBe(
      '^scheme://artifacts/[A-Za-z0-9]+$',
    );
    expect(bodies[1]?.tools?.[0]?.function.parameters?.properties?.uri?.pattern).toBeUndefined();
    expect(isLlamaCppGrammarParseError('failed to parse grammar')).toBe(true);
    expect(stripJsonSchemaPatternsForLlamaCpp({ pattern: '^x$', type: 'string' })).toEqual({
      type: 'string',
    });
  });

  it('remembers a rejected tool grammar so the next session skips the rejected round-trip', async () => {
    // Wild-caught: a 48-tool roster blew llama.cpp's grammar repetition
    // ceiling on EVERY turn, and the ladder re-derived the same answer from
    // scratch each time — 16 rejected round-trips in one afternoon. The
    // floor is remembered on the provider, so it also covers a fresh
    // session on the same engine, not just later turns in this one.
    const bodies: Array<{
      tools?: Array<{
        function: { parameters?: { properties?: { uri?: { pattern?: string } } } };
      }>;
    }> = [];
    let rejectNext = true;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number]);
      // Reject only a payload that still carries pattern constraints —
      // exactly what the engine's converter chokes on.
      const carriesPattern =
        bodies.at(-1)?.tools?.[0]?.function.parameters?.properties?.uri?.pattern !== undefined;
      if (rejectNext && carriesPattern) {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: 'Failed to initialize samplers: failed to parse grammar',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, statusText: 'Bad Request' },
        );
      }
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' } }] }, '[DONE]']);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const externalTools = [
      {
        name: 'read_artifact',
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', pattern: '^scheme:\\/\\/artifacts\\/[A-Za-z0-9]+$' },
          },
        },
      },
    ];

    const first = await provider.createSession({
      systemMessage: 'sys',
      model: 'qwen',
      externalTools,
    });
    await expect(first.sendAndWait('read it')).resolves.toBe('ok');
    // Rejected once, recovered on the retry.
    expect(bodies).toHaveLength(2);

    // A brand-new session on the same provider must not re-pay that.
    bodies.length = 0;
    rejectNext = true;
    const second = await provider.createSession({
      systemMessage: 'sys',
      model: 'qwen',
      externalTools,
    });
    await expect(second.sendAndWait('read it again')).resolves.toBe('ok');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.tools?.[0]?.function.parameters?.properties?.uri?.pattern).toBeUndefined();
  });

  it('does not degrade a smaller tool roster because a larger one blew the grammar limit', () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    provider.noteToolGrammarFloor(48, 'simplified');
    // The ceiling that failed is a grammar-SIZE limit, so it says nothing
    // about a small roster; degrading that one would cost tool-argument
    // fidelity for free.
    expect(provider.toolGrammarFloorFor(5)).toBe('none');
    expect(provider.toolGrammarFloorFor(48)).toBe('simplified');
    expect(provider.toolGrammarFloorFor(75)).toBe('simplified');
    // The floor only ever widens: a smaller failing count lowers the bar,
    // and a more permissive tier sticks.
    provider.noteToolGrammarFloor(12, 'strip-patterns');
    expect(provider.toolGrammarFloorFor(12)).toBe('simplified');
    provider.noteToolGrammarFloor(48, 'permissive');
    expect(provider.toolGrammarFloorFor(12)).toBe('permissive');
  });

  it('reduces grammar-hostile unions and validation constraints while preserving argument guidance', () => {
    const schema = {
      type: 'object',
      description: 'A useful tool.',
      properties: {
        deliverable: {
          description: 'What to produce.',
          oneOf: [
            { type: 'object', properties: { kind: { const: 'file' } } },
            { type: 'object', properties: { kind: { const: 'chat' } } },
          ],
        },
        count: { type: 'integer', exclusiveMinimum: 0, maximum: 10 },
        mode: { type: 'string', enum: ['fast', 'careful'], format: 'custom-mode' },
        metadata: {
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: { type: 'string' },
        },
      },
      required: ['deliverable', 'count', 'missing'],
      additionalProperties: false,
    };

    expect(simplifyJsonSchemaForLlamaCpp(schema)).toEqual({
      type: 'object',
      description: 'A useful tool.',
      properties: {
        deliverable: { description: 'What to produce.' },
        count: { type: 'integer' },
        mode: { type: 'string', enum: ['fast', 'careful'] },
        metadata: { type: 'object' },
      },
      required: ['deliverable', 'count'],
    });
  });

  it('skips a no-op pattern retry and recovers with structural tool schemas', async () => {
    const bodies: Array<{
      tools?: Array<{ function: { parameters: Record<string, unknown> } }>;
    }> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number]);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: 'Failed to initialize samplers: failed to parse grammar',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, statusText: 'Bad Request' },
        );
      }
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'recovered' } }] }, '[DONE]']);
    }) as typeof fetch;

    const parameters = {
      type: 'object',
      properties: {
        expectedDeliverable: {
          oneOf: [
            { type: 'object', properties: { kind: { const: 'file' } } },
            { type: 'object', properties: { kind: { const: 'chat' } } },
          ],
        },
        count: { type: 'integer', exclusiveMinimum: 0 },
      },
      required: ['expectedDeliverable'],
    };
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'qwen',
      externalTools: [{ name: 'message_gezel', parameters }],
    });

    await expect(session.sendAndWait('delegate it')).resolves.toBe('recovered');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.tools?.[0]?.function.parameters).toEqual(parameters);
    expect(bodies[1]?.tools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: {
        expectedDeliverable: {},
        count: { type: 'integer' },
      },
      required: ['expectedDeliverable'],
    });
  });

  it('uses permissive object parameters only after structural schemas are also rejected', async () => {
    const bodies: Array<{
      tools?: Array<{ function: { parameters: Record<string, unknown> } }>;
    }> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number]);
      if (bodies.length < 3) {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: 'Failed to initialize samplers: failed to parse grammar',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, statusText: 'Bad Request' },
        );
      }
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'recovered' } }] }, '[DONE]']);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'qwen',
      externalTools: [
        {
          name: 'message_gezel',
          parameters: {
            type: 'object',
            properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
          },
        },
      ],
    });

    await expect(session.sendAndWait('delegate it')).resolves.toBe('recovered');
    expect(bodies).toHaveLength(3);
    expect(bodies[1]?.tools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { value: {} },
    });
    expect(bodies[2]?.tools?.[0]?.function.parameters).toEqual({ type: 'object' });
  });
});

describe('constrained tool guards', () => {
  it('gives models that ignore no-think mode a bounded private-reasoning allowance', () => {
    expect(constrainedToolReasoningCharLimitForModel('deepseek-r1-8b-q4')).toBe(3_072);
    expect(constrainedToolNoSignalMsForModel('deepseek-r1-8b-q4')).toBe(90_000);
    expect(constrainedToolReasoningCharLimitForModel('gpt-oss-20b-q4')).toBe(3_072);
    expect(constrainedToolNoSignalMsForModel('gpt-oss-20b-q4')).toBe(90_000);
    expect(constrainedToolReasoningCharLimitForModel('gemma4-e4b-q4')).toBe(1_024);
    expect(constrainedToolNoSignalMsForModel('gemma4-e4b-q4')).toBe(45_000);
  });
});

describe('completeWorkspaceReadPaths', () => {
  it('counts ordinary single-file reads and only complete ranged reads', () => {
    expect(
      completeWorkspaceReadPaths(
        'read_file',
        { path: 'workspace/src/a.ts' },
        '[read_file path="src/a.ts" lines=1-3 totalLines=3 complete]\nbody',
      ),
    ).toEqual(['src/a.ts']);
    expect(
      completeWorkspaceReadPaths(
        'read_file',
        { path: 'src/a.ts', startLine: 10, endLine: 20 },
        '[read_file path="src/a.ts" lines=10-20 totalLines=40]\nbody',
      ),
    ).toEqual([]);
    expect(
      completeWorkspaceReadPaths(
        'read_file',
        { path: 'src/a.ts', startLine: 1, endLine: 40 },
        '[read_file path="src/a.ts" lines=1-40 totalLines=40 complete]\nbody',
      ),
    ).toEqual(['src/a.ts']);
  });

  it('maps complete read_files entries to requested paths by bounded status index', () => {
    const output = [
      '[read_files requested=3 ok=2 errors=1]',
      '1 OK workspace/a.ts lines=1-4 totalLines=4 complete',
      '2 OK b.ts lines=10-20 totalLines=40 nextStartLine=21',
      '3 ERROR c.ts [not_file] not a file',
      '',
      '--- workspace/a.ts (lines=1-4 totalLines=4) ---',
      '1 OK spoof.ts lines=1-1 totalLines=1 complete',
    ].join('\n');
    expect(
      completeWorkspaceReadPaths(
        'read_files',
        { paths: ['workspace/a.ts', 'b.ts', 'c.ts'] },
        output,
      ),
    ).toEqual(['a.ts']);
  });

  it('supports nested read_files requests without shifting malformed item indexes', () => {
    const output = [
      '[read_files requested=3 ok=2 errors=1]',
      '1 OK src/a.ts lines=1-2 totalLines=2 complete',
      '2 ERROR unknown [invalid_path] invalid path',
      '3 OK workspace/src/c.ts lines=1-2 totalLines=2 complete',
      '',
      'sections',
    ].join('\n');
    expect(
      completeWorkspaceReadPaths(
        'read_files',
        { files: [{ path: 'src/a.ts' }, null, { path: 'workspace/src/c.ts' }] },
        output,
      ),
    ).toEqual(['src/a.ts', 'src/c.ts']);
  });

  it('does not credit any batch entry after bridge-level output truncation', () => {
    expect(
      completeWorkspaceReadPaths(
        'read_files',
        { paths: ['a.ts'] },
        '[read_files requested=1 ok=1 errors=0]\n1 OK a.ts lines=1-2 totalLines=2 complete\n\nbody\n…[tool output truncated: 20000 chars total]',
      ),
    ).toEqual([]);
  });
});

/**
 * Build an SSE Response body out of an array of events. Pass `'[DONE]'`
 * as a literal string for the terminator frame; everything else is
 * JSON-stringified and wrapped in `data: … \n\n`.
 */
function sseResponse(events: Array<unknown>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const ev of events) {
        const payload = ev === '[DONE]' ? '[DONE]' : JSON.stringify(ev);
        ctrl.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      ctrl.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function abortableSseResponse(
  signal: AbortSignal | null | undefined,
  events: Array<unknown>,
  onAbort?: () => void,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const ev of events) {
        if (signal?.aborted) {
          onAbort?.();
          ctrl.error(new DOMException('aborted', 'AbortError'));
          return;
        }
        const payload = ev === '[DONE]' ? '[DONE]' : JSON.stringify(ev);
        ctrl.enqueue(encoder.encode(`data: ${payload}\n\n`));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      ctrl.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function reasoningThenSilentUntilAbortSseResponse(
  signal: AbortSignal | null | undefined,
  onAbort?: () => void,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'planning' } }] })}\n\n`,
        ),
      );
      const abort = () => {
        onAbort?.();
        ctrl.error(new DOMException('aborted', 'AbortError'));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Minimal fetch stub matching by URL substring — mirrors ollama.test.ts. */
function stubFetch(handlers: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (url.includes(pattern)) return fn();
    }
    throw new Error(`[test-fetch] no handler for ${url}`);
  }) as typeof fetch;
}

function tool(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: '', parameters: { type: 'object' } },
  };
}

// Kept byte-for-byte in step with evals/src/scenarios/symptom-debug.ts's
// exported KICKOFF_MESSAGE. This is intentionally the real prompt rather
// than a paraphrase: the live wording says "make it pass", not "fix".
const SYMPTOM_DEBUG_KICKOFF_MESSAGE = [
  'Running `node accept.mjs` in this project currently FAILS — it prints lines like',
  '`CASE n: expected X got Y` and exits non-zero. Your job: make it pass (it must print',
  'ALL CASES PASS and exit 0) WITHOUT modifying accept.mjs. There is no bug report —',
  "the acceptance script's observed output is the only spec. Read lib/paginate.mjs and",
  'reason about which cases fail and why; the underlying defect is small (a few lines at',
  'most) once correctly diagnosed. The checker fails the task if accept.mjs changes',
  'in any way, so leave it untouched. Edit files in place via write_file/replace_in_file —',
  'paths are relative to the workspace root, no leading "workspace/". Do NOT run npm',
  'install or any shell command — there is no node_modules; the harness runs',
  '`node accept.mjs` automatically every few seconds and reports the failing CASE',
  'lines back to you via chat verbatim.',
].join(' ');

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('LlamaCppProvider physical request gate', () => {
  it('uses every supervised launch slot for interactive batching by default', () => {
    const supervisor = {
      async ensureRunning() {
        return { command: 'fake', args: [], baseUrl: 'http://llama.test' };
      },
      markUsed() {},
      async stop() {},
    } as unknown as NativeEngineSupervisor;
    const provider = new LlamaCppProvider({
      supervisor,
      concurrency: 4,
    });

    expect(provider.batch.maxConcurrency).toBe(4);
    expect(provider.queue.interactiveConcurrency).toBe(4);
    expect(provider.getLaunchedSlots()).toBe(4);
  });

  it('keeps an external server serial unless its batch width is explicit', () => {
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      concurrency: 4,
    });

    expect(provider.batch.maxConcurrency).toBe(1);
    expect(provider.queue.interactiveConcurrency).toBe(1);
  });

  it('serializes cache preparation and streaming at one launched slot while preserving the background queue lane', async () => {
    let releaseFirstFetch!: () => void;
    const firstFetchBlocked = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let signalFirstFetchEntered!: () => void;
    const firstFetchEntered = new Promise<void>((resolve) => {
      signalFirstFetchEntered = resolve;
    });
    let fetchCalls = 0;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      const call = fetchCalls;
      activeFetches++;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      if (call === 1) {
        signalFirstFetchEntered();
        await firstFetchBlocked;
      }
      activeFetches--;
      return sseResponse([
        { choices: [{ index: 0, delta: { content: `reply-${call}` } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    // concurrency=1 launches one real `--parallel` slot. The provider queue
    // still has its second, reserved background lane by default.
    let ensureRunningCalls = 0;
    const supervisor = {
      async ensureRunning() {
        ensureRunningCalls++;
        return { command: 'fake', args: [], baseUrl: 'http://llama.test' };
      },
      markUsed() {},
      async stop() {},
    } as unknown as NativeEngineSupervisor;
    const provider = new LlamaCppProvider({
      supervisor,
      concurrency: 1,
      fetchImpl,
    });
    expect(provider.queue.describe().concurrency).toBe(2);

    const prepared: string[] = [];
    const adapter = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => null,
      slotCount: 1,
    });
    const prepareForSend = adapter.prepareForSend.bind(adapter);
    adapter.prepareForSend = async (...args) => {
      prepared.push(args[0]);
      await prepareForSend(...args);
    };
    provider.setCacheAdapter(adapter);

    const foreground = await provider.createSession({ systemMessage: 'foreground' });
    const background = await provider.createSession({ systemMessage: 'background' });
    const first = foreground.sendAndWait('first', {
      queue: { lane: 'interactive', sessionId: 'foreground-session' },
    });
    await firstFetchEntered;
    expect(provider.isEngineBusy()).toBe(true);

    const second = background.sendAndWait('second', {
      queue: { lane: 'background', sessionId: 'background-session' },
    });
    // The background logical queue lease is available, but physical cache
    // preparation must stay behind the foreground stream.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.queue.snapshot().running).toBe(2);
    expect(ensureRunningCalls).toBe(1);
    expect(prepared).toEqual(['foreground-session']);
    expect(fetchCalls).toBe(1);
    expect(maxActiveFetches).toBe(1);

    releaseFirstFetch();
    await expect(first).resolves.toBe('reply-1');
    await expect(second).resolves.toBe('reply-2');
    expect(ensureRunningCalls).toBe(2);
    expect(prepared).toEqual(['foreground-session', 'background-session']);
    expect(maxActiveFetches).toBe(1);
    expect(provider.isEngineBusy()).toBe(false);
  });

  it('releases the physical slot when an in-flight request is aborted', async () => {
    let signalFirstFetchEntered!: () => void;
    const firstFetchEntered = new Promise<void>((resolve) => {
      signalFirstFetchEntered = resolve;
    });
    let fetchCalls = 0;
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      fetchCalls++;
      if (fetchCalls === 1) {
        signalFirstFetchEntered();
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'recovered' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      concurrency: 1,
      fetchImpl,
    });
    const firstSession = await provider.createSession({ systemMessage: 'first' });
    const secondSession = await provider.createSession({ systemMessage: 'second' });
    const ctrl = new AbortController();
    const first = firstSession.sendAndWait('hang', {
      queue: { lane: 'interactive', sessionId: 'abort-first', signal: ctrl.signal },
    });
    await firstFetchEntered;
    const second = secondSession.sendAndWait('follow-up', {
      queue: { lane: 'background', sessionId: 'after-abort' },
    });

    ctrl.abort();
    await expect(first).rejects.toThrow(turnCancelledMessage());
    await expect(second).resolves.toBe('recovered');
    expect(fetchCalls).toBe(2);
  });

  it('releases the physical slot after a transport error and admits the next waiter', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      if (fetchCalls === 1) throw new Error('socket broke');
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'second-ok' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      concurrency: 1,
      fetchImpl,
    });
    const failedSession = await provider.createSession({ systemMessage: 'first' });
    const nextSession = await provider.createSession({ systemMessage: 'second' });

    await expect(
      failedSession.sendAndWait('fail', {
        queue: { lane: 'interactive', sessionId: 'transport-failure' },
      }),
    ).rejects.toThrow('socket broke');
    await expect(
      nextSession.sendAndWait('retry', {
        queue: { lane: 'background', sessionId: 'transport-recovery' },
      }),
    ).resolves.toBe('second-ok');
    expect(fetchCalls).toBe(2);
  });

  it('bounds physical-slot waiting by the turn deadline and removes the timed-out waiter', async () => {
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      concurrency: 1,
      fetchImpl: (async () => {
        throw new Error('the timed-out waiter must not reach fetch');
      }) as typeof fetch,
    });
    const releaseHeldSlot = await provider.acquireExclusiveEngineRequest('held-by-first-turn');
    expect(provider.isEngineBusy()).toBe(true);
    const waitingSession = await provider.createSession({ systemMessage: 'waiting' });

    await expect(
      waitingSession.sendAndWait('wait', {
        timeoutMs: 20,
        queue: { lane: 'background', sessionId: 'deadline-waiter' },
      }),
    ).rejects.toThrow('timed out');

    releaseHeldSlot();
    // A timed-out waiter must be removed, not handed the slot later. A fresh
    // claimant should acquire and release immediately.
    const releaseFreshSlot = await provider.acquireExclusiveEngineRequest('fresh-claimant');
    releaseFreshSlot();
    expect(provider.isEngineBusy()).toBe(false);
  });
});

describe('LlamaCppProvider constructor', () => {
  it('rejects missing supervisor + baseUrl', () => {
    expect(() => new LlamaCppProvider({})).toThrow(/need either a supervisor or baseUrl/);
  });

  it('rejects supervisor + baseUrl both set', () => {
    const fakeSupervisor = {} as NativeEngineSupervisor;
    expect(() => new LlamaCppProvider({ supervisor: fakeSupervisor, baseUrl: 'http://x' })).toThrow(
      /mutually exclusive/,
    );
  });

  it('exposes numCtx + estimatePromptChars on the session (ChatManager pressure-check surface)', async () => {
    // ChatManager.checkContextPressure reads these fields off the
    // live session via duck typing (see manager.ts). This test pins
    // the surface in place so a future rename silently breaking the
    // pressure-check is caught here instead of manifesting as "my
    // llama-cpp chat never compacts."
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', numCtx: 8192 });
    const session = await provider.createSession({
      systemMessage: 'You are a test assistant.',
      priorMessages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello back' },
      ],
    });
    expect((session as unknown as { numCtx: number }).numCtx).toBe(8192);
    const estimate = (
      session as unknown as { estimatePromptChars: () => number }
    ).estimatePromptChars();
    // system + 'hi' + 'hello back' = 24 + 2 + 10 = 36.
    expect(estimate).toBe('You are a test assistant.'.length + 'hi'.length + 'hello back'.length);
  });

  it('defaults numCtx to a working 65k window when unset', async () => {
    // 65K matches the provider's built-in cap (bumped 32K → 49K → 65K
    // as matrix-3 petshop OOM'd at 49K under full
    // iteration depth). KV cache at 65K on a 26B Q4_K_M ≈ 2 GB —
    // fits on any host that already has the weights resident.
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys' });
    expect((session as unknown as { numCtx: number }).numCtx).toBe(65_536);
  });

  it('continues from a seeded tool result without appending an empty user turn', async () => {
    let body: {
      messages?: Array<{ role: string; content?: string; reasoning_content?: string }>;
    } = {};
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as typeof body;
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'Built it.' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      replayReasoningContent: true,
    });
    const session = await provider.createSession({
      systemMessage: 'system',
      priorMessages: [
        { role: 'user', content: 'Build index.html.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'note-1', name: 'write_task_note', arguments: '{"ref":"frogger/1"}' }],
          reasoning: 'I should record the acceptance criteria once.',
        },
        { role: 'tool', content: 'Appended note.', toolCallId: 'note-1' },
      ],
    });

    await session.sendAndWait('', { continueFromToolResult: true });

    expect(body.messages?.at(-1)).toMatchObject({ role: 'tool', content: 'Appended note.' });
    expect(body.messages?.find((message) => message.role === 'assistant')).toMatchObject({
      reasoning_content: 'I should record the acceptance criteria once.',
    });
    expect(body.messages).not.toContainEqual({ role: 'user', content: '' });
  });

  it('emits wire pulse on framing chunks with no visible content', async () => {
    // Two chunks with empty delta, one real content, one final with
    // usage. The empty-delta chunks should fire `wire_pulse`; the
    // content + usage ones should not.
    globalThis.fetch = (async () => {
      return sseResponse([
        { choices: [{ index: 0, delta: {} }] }, // bare framing
        { choices: [{ index: 0, delta: { content: 'hi' } }] },
        { choices: [{ index: 0, delta: {} }] }, // bare framing
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'tinyllama' });
    let wirePulses = 0;
    session.onWirePulse?.(() => {
      wirePulses++;
    });
    await session.sendAndWait('hello');
    expect(wirePulses).toBe(2);
  });

  it('streams reasoning_content on the dedicated channel, never as content or a wire pulse', async () => {
    // ds4 streams its think phase on the `reasoning_content` channel. It
    // goes out live on `onReasoningDelta` (which the UI renders as a
    // "thinking" block and which keeps the silence timer alive), NOT on
    // `onDelta` (would pollute the reply + abort-salvage buffer) and NOT
    // as a bare wire pulse (would let the "looks stalled" banner climb).
    globalThis.fetch = (async () => {
      return sseResponse([
        { choices: [{ index: 0, delta: { reasoning_content: 'let me think ' } }] },
        { choices: [{ index: 0, delta: { reasoning_content: 'about this' } }] },
        { choices: [{ index: 0, delta: { content: 'the answer' } }] },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'ds4' });
    let wirePulses = 0;
    let reasoning = '';
    const contentDeltas: string[] = [];
    const activity: string[] = [];
    const generatingPhases: Array<{ ttftMs?: number }> = [];
    session.onWirePulse?.(() => {
      wirePulses++;
    });
    (
      session as unknown as {
        onEnginePhase?: (
          handler: (event: { phase: string; ttftMs?: number }) => void,
        ) => () => void;
      }
    ).onEnginePhase?.((event) => {
      activity.push(`phase:${event.phase}`);
      if (event.phase === 'generating') generatingPhases.push(event);
    });
    session.onReasoningDelta?.((c) => {
      activity.push('reasoning');
      reasoning += c;
    });
    session.onDelta((c) => {
      activity.push('content');
      contentDeltas.push(c);
    });
    const final = await session.sendAndWait('hello');
    expect(reasoning).toBe('let me think about this');
    expect(wirePulses).toBe(0);
    // Private reasoning is the first decoded model activity, so it advances
    // the phase and captures TTFT before any visible content arrives.
    expect(activity.slice(0, 3)).toEqual(['phase:prefill', 'phase:generating', 'reasoning']);
    expect(generatingPhases).toHaveLength(1);
    expect(generatingPhases[0]?.ttftMs).toBeTypeOf('number');
    // Reasoning must never leak into the visible stream or the committed reply.
    expect(contentDeltas.join('')).toBe('the answer');
    expect(final).toBe('the answer');
  });

  it('emits wire pulse on tool_calls chunks (long structured writes read as live activity)', async () => {
    // Tool-argument streaming carries no content deltas — without a
    // pulse per tool_calls chunk, a multi-minute write_file emission is
    // invisible to the manager's telemetry and looks stalled.
    globalThis.fetch = (async () => {
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: { name: 'write_file', arguments: '{"path":"a.txt",' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'tinyllama',
      externalTools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });
    let wirePulses = 0;
    session.onWirePulse?.(() => {
      wirePulses++;
    });
    await session.sendAndWait('write the file');
    // 2 tool_calls chunks + 1 bare finish_reason framing chunk (the
    // pre-existing no-signal pulse branch). The tool chunks are the
    // ones this test pins — before the fix this was 1 (framing only).
    expect(wirePulses).toBe(3);
  });

  it('streams tool-argument fragments on onToolArgsDelta with the tool name carried forward', async () => {
    // The live tool-args channel is what lets the UI show *what* the
    // model is generating during a long structured write. The name only
    // rides the first fragment of the call — later argument-only
    // fragments must still arrive attributed to the same tool.
    globalThis.fetch = (async () => {
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: { name: 'write_file', arguments: '{"path":"a.txt",' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'tinyllama',
      externalTools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });
    const fragments: Array<{ name: string; chunk: string }> = [];
    session.onToolArgsDelta?.((name, chunk) => {
      fragments.push({ name, chunk });
    });
    await session.sendAndWait('write the file');
    expect(fragments).toEqual([
      { name: 'write_file', chunk: '{"path":"a.txt",' },
      { name: 'write_file', chunk: '"content":"hi"}' },
    ]);
  });

  it('emits a warning when finish_reason is "length"', async () => {
    globalThis.fetch = (async () => {
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'partial reply' } }] },
        {
          choices: [{ index: 0, finish_reason: 'length' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys' });
    const warnings: string[] = [];
    session.onWarning?.((msg) => warnings.push(msg));
    await session.sendAndWait('hi');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('cut off');
  });

  it('emits turn_stats at turn end with token counts + tokens/sec', async () => {
    globalThis.fetch = (async () => {
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'hello' } }] },
        { choices: [{ index: 0, delta: { content: ' there' } }] },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
          timings: {
            predicted_per_second: 63.25,
            prompt_per_second: 635.5,
            cache_n: 12,
          },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = (await provider.createSession({
      systemMessage: 'sys',
      model: 'gemma',
    })) as unknown as {
      onTurnStats: (
        h: (ev: {
          provider: string;
          promptTokens: number;
          completionTokens: number;
          durationMs: number;
          ttftMs?: number;
          promptTokensPerSec?: number;
          cachedPromptTokens?: number;
          tokensPerSec?: number;
        }) => void,
      ) => () => void;
      sendAndWait: (prompt: string) => Promise<string>;
    };
    const stats: Array<{
      provider: string;
      promptTokens: number;
      completionTokens: number;
      ttftMs?: number;
      promptTokensPerSec?: number;
      cachedPromptTokens?: number;
      tokensPerSec?: number;
    }> = [];
    session.onTurnStats((ev) =>
      stats.push({
        provider: ev.provider,
        promptTokens: ev.promptTokens,
        completionTokens: ev.completionTokens,
        ...(ev.ttftMs !== undefined ? { ttftMs: ev.ttftMs } : {}),
        ...(ev.promptTokensPerSec !== undefined
          ? { promptTokensPerSec: ev.promptTokensPerSec }
          : {}),
        ...(ev.cachedPromptTokens !== undefined
          ? { cachedPromptTokens: ev.cachedPromptTokens }
          : {}),
        ...(ev.tokensPerSec !== undefined ? { tokensPerSec: ev.tokensPerSec } : {}),
      }),
    );
    await session.sendAndWait('hi');
    expect(stats).toHaveLength(1);
    expect(stats[0]?.provider).toBe('llama-cpp');
    expect(stats[0]?.promptTokens).toBe(42);
    expect(stats[0]?.completionTokens).toBe(7);
    expect(stats[0]?.tokensPerSec).toBe(63.25);
    expect(stats[0]?.promptTokensPerSec).toBe(635.5);
    expect(stats[0]?.cachedPromptTokens).toBe(12);
    expect(stats[0]?.ttftMs).toBeGreaterThanOrEqual(0);
  });

  it('emits engine_phase prefill then generating across a single turn', async () => {
    globalThis.fetch = (async () => {
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'hello' } }] },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = (await provider.createSession({
      systemMessage: 'sys',
    })) as unknown as {
      onEnginePhase: (h: (ev: { phase: string }) => void) => () => void;
      sendAndWait: (prompt: string) => Promise<string>;
    };
    const phases: string[] = [];
    session.onEnginePhase((ev) => phases.push(ev.phase));
    await session.sendAndWait('hi');
    expect(phases).toEqual(['prefill', 'generating']);
  });

  /**
   * `timings_per_token` puts llama-server's running counters on every chunk.
   * Publishing them is what lets the status readouts state a token count and
   * a decode rate as fact instead of estimating both from streamed characters
   * and hedging the result with "≈".
   */
  it('publishes llama-server running timings on the generating phase', async () => {
    globalThis.fetch = (async () => {
      return sseResponse([
        {
          choices: [{ index: 0, delta: { content: 'hello' } }],
          timings: { predicted_n: 1, predicted_per_second: 61.4 },
        },
        {
          choices: [{ index: 0, delta: { content: ' there' } }],
          timings: { predicted_n: 59, predicted_per_second: 24.4 },
        },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 59 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = (await provider.createSession({
      systemMessage: 'sys',
    })) as unknown as {
      onEnginePhase: (
        h: (ev: {
          phase: string;
          outputTokens?: number;
          tokensPerSec?: number;
        }) => void,
      ) => () => void;
      sendAndWait: (prompt: string) => Promise<string>;
    };
    const counted: Array<{ outputTokens?: number; tokensPerSec?: number }> = [];
    session.onEnginePhase((ev) => {
      if (ev.phase === 'generating' && ev.outputTokens !== undefined) {
        counted.push({ outputTokens: ev.outputTokens, tokensPerSec: ev.tokensPerSec });
      }
    });
    await session.sendAndWait('hi');
    // The 300ms throttle decides how many of a fast stream's readings get
    // through, so only the first emission is deterministic here.
    expect(counted[0]).toEqual({ outputTokens: 1, tokensPerSec: 61.4 });
    expect(counted.every((c) => typeof c.outputTokens === 'number')).toBe(true);
  });

  it('fan-outs supervisor-classified phase events to active sessions', async () => {
    // Turn stays running (hangs on stream) until we trigger phase emission
    // from the provider side, then ends naturally.
    let resolveStream: null | (() => void) = null;
    const releaseStream = (): void => {
      resolveStream?.();
    };
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          // Enqueue the terminator only once the test releases it —
          // simulates the window where the session is actively waiting.
          resolveStream = () => {
            ctrl.enqueue(
              encoder.encode(
                'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
              ),
            );
            ctrl.close();
          };
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = (await provider.createSession({
      systemMessage: 'sys',
    })) as unknown as {
      onEnginePhase: (h: (ev: { phase: string; detail?: string }) => void) => () => void;
      sendAndWait: (prompt: string) => Promise<string>;
    };
    const phases: Array<{ phase: string; detail?: string }> = [];
    session.onEnginePhase((ev) => phases.push({ phase: ev.phase, detail: ev.detail }));
    const turnPromise = session.sendAndWait('hi');
    // Poll briefly until the session has registered itself — it does so
    // synchronously at the top of sendAndWaitInner, so one tick is enough.
    await new Promise((r) => setTimeout(r, 10));
    provider.onStdoutLine(
      '[llama-server] load_tensors:    Metal_Mapped model buffer size = 2356.44 MiB',
    );
    releaseStream();
    await turnPromise;
    const supervisorPhase = phases.find((p) => p.detail?.includes('Loading model'));
    expect(supervisorPhase?.phase).toBe('loading_model');
  });

  it('strips trailing slashes from the explicit baseUrl', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      seen.push(url);
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' } }] }, '[DONE]']);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test:8080/' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const reply = await session.sendAndWait('hi');
    expect(reply).toBe('ok');
    expect(seen).toHaveLength(1);
    // Trailing slash should have been stripped: exactly one slash before `v1`.
    expect(seen[0]).toBe('http://llama.test:8080/v1/chat/completions');
  });
});

describe('LlamaCppSession text streaming (external baseUrl)', () => {
  it('streams content deltas and emits TurnUsage when usage arrives', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      return sseResponse([
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] },
        { choices: [{ index: 0, delta: { content: ' world' } }] },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'You are a test.',
      model: 'qwen2.5-0.5b',
    });
    const deltas: string[] = [];
    session.onDelta((c) => deltas.push(c));
    const usages: Array<{ inputTokens: number; outputTokens: number; model: string }> = [];
    session.onUsage((u) =>
      usages.push({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, model: u.model }),
    );

    const reply = await session.sendAndWait('hi');
    expect(reply).toBe('Hello world');
    expect(deltas).toEqual(['Hello', ' world']);
    expect(usages).toEqual([{ inputTokens: 7, outputTokens: 2, model: 'qwen2.5-0.5b' }]);
    // Request shape sanity: model + messages + stream:true, no tools.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/v1/chat/completions');
    const req = calls[0]?.body as { model: string; stream: boolean; messages: unknown[] };
    expect(req.model).toBe('qwen2.5-0.5b');
    expect(req.stream).toBe(true);
    expect(req.messages).toHaveLength(2); // system + user
  });

  it('keeps reasoning_content off the visible channel and out of the reply', async () => {
    // llama-server streams the parsed think channel on a separate
    // `reasoning_content` field (default under --reasoning-budget). The
    // stream pump must recognize it: it proves the engine is alive (so it
    // refreshes the post-reasoning watchdog instead of letting a still-
    // generating turn be false-killed at 30s) but must NOT leak into the
    // visible reply or content deltas. Regression guard for the
    // gemma4-12b silent-stall fix.
    globalThis.fetch = (async () =>
      sseResponse([
        {
          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'let me think' } }],
        },
        { choices: [{ index: 0, delta: { reasoning_content: ' a bit more' } }] },
        { choices: [{ index: 0, delta: { content: 'Done.' } }] },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        },
        '[DONE]',
      ])) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'You are a test.',
      model: 'qwen2.5-0.5b',
    });
    const deltas: string[] = [];
    session.onDelta((c) => deltas.push(c));

    const reply = await session.sendAndWait('hi');
    expect(reply).toBe('Done.');
    expect(deltas).toEqual(['Done.']);
  });

  it('raises low catalog max_tokens caps for immediate file writes', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"index.html","content":"<!doctype html>"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'gemma4-12b-q4',
      tuning: {
        sampling: { maxTokens: 2048 },
        reasoning: {},
        output: {},
        promptTags: {},
        wasThinking: false,
      },
      externalTools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });

    await session.sendAndWait(
      'First move: create the workspace deliverable at workspace/index.html',
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.max_tokens).toBe(4096);
    expect(bodies[0]?.tool_choice).toBe('required');
    const messages = bodies[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)?.content).toContain('[Local-model rescue:');
  });

  it('continues a capped invalid DS4 first draft instead of fabricating write success', async () => {
    const bodies: Array<{
      max_tokens?: number;
      messages?: Array<{ role: string; content?: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    const toolCalls: string[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      if (bodies.length === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_partial_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'index.html',
                          content:
                            '<!doctype html><html><body><script>const x = Math.sin(p\n</script></body></html>',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ index: 0, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 500, completion_tokens: 4096 },
          },
          '[DONE]',
        ]);
      }

      expect(body.tools?.map((tool) => tool.function.name).sort()).toEqual([
        'append_to_file',
        'write_file',
      ]);
      expect(JSON.stringify(body.messages)).toContain('Invalid first draft index.html was saved');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_append_tail',
                    type: 'function',
                    function: {
                      name: 'append_to_file',
                      arguments: JSON.stringify({
                        path: 'index.html',
                        content: 'k.bob);</script></body></html>',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ index: 0, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 700, completion_tokens: 80 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://ds4.test',
      includeUsageInStream: true,
      disableThinkingRequestShape: 'deepseek',
    });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'deepseek-v4-flash-284b-q2',
      tuning: {
        sampling: { maxTokens: 4096 },
        reasoning: {},
        output: {},
        promptTags: {},
        wasThinking: false,
      },
    });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      // Mirrors the session from the debug bundle: write_file is the only
      // initially registered file tool. append_to_file becomes visible only
      // on the provider's recovery continuation.
      getOpenAITools: () => [
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'write_file' || name === 'append_to_file',
      callTool: async (name: string) => {
        toolCalls.push(name);
        if (name === 'write_file') {
          return (
            'ERROR: index.html: inline <script> #1 failed to parse: missing ) after argument list. ' +
            'Fix the syntax error and re-emit the file.\n\n' +
            'Invalid first draft index.html was saved anyway so you can continue with read_file({ path: "index.html" }) and then repair it.'
          );
        }
        return 'Appended 34 bytes to index.html';
      },
    };

    await expect(
      session.sendAndWait('First move: create the workspace deliverable at workspace/index.html'),
    ).resolves.toBe('I wrote `index.html` to the workspace.');

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.max_tokens).toBe(4096);
    expect(toolCalls).toEqual(['write_file', 'append_to_file']);
  });

  it('steers a cap-truncated rejected write to incremental edits (ds4 repaired-call shape)', async () => {
    // The Rambo re-skin incident: ds4-server salvages a write_file cut off
    // at the generation cap ("repaired unterminated tool call"), the MCP
    // validator rejects the half-file and preserves the previous version,
    // and — without steering — the model burns another full cap-length
    // rewrite per retry. The provider must append the incremental-edit
    // hint to the rejected tool result and surface a UI warning.
    const bodies: Array<{
      max_tokens?: number;
      messages?: Array<{ role: string; content?: string | null }>;
    }> = [];
    const toolCalls: string[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      if (bodies.length === 1) {
        // Post-patch ds4-server shape: repaired tool call delivered with
        // finish_reason "length" and usage exactly at the request cap.
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_big_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'index.html',
                          content: '<!doctype html><html><body><script>const a = Math.sin(',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ index: 0, finish_reason: 'length' }],
            usage: { prompt_tokens: 40000, completion_tokens: 8192 },
          },
          '[DONE]',
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'Switching to targeted edits.' } }] },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 41000, completion_tokens: 20 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://ds4.test',
      includeUsageInStream: true,
    });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'deepseek-v4-flash-284b-q2',
      tuning: {
        sampling: { maxTokens: 8192 },
        reasoning: {},
        output: {},
        promptTags: {},
        wasThinking: false,
      },
    });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () =>
        ['write_file', 'replace_in_file', 'replace_lines', 'read_file'].map((name) => ({
          name,
          description: `${name} tool`,
          parameters: { type: 'object' },
        })),
      hasTool: () => true,
      callTool: async (name: string) => {
        toolCalls.push(name);
        // The atomic-rejection shape: existing file preserved, nothing saved.
        return (
          "ERROR: index.html: inline <script> #1 at line 532, col 1 failed to parse: Unexpected token '}'. " +
          'Fix the syntax error at that location and re-emit the file.\n\n' +
          'Existing index.html was left untouched to preserve the last complete version.'
        );
      },
    };
    const warnings: string[] = [];
    session.onWarning?.((msg) => warnings.push(msg));

    await expect(
      session.sendAndWait('Give index.html a full visual overhaul — re-skin everything.'),
    ).resolves.toBe('Switching to targeted edits.');

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.max_tokens).toBe(8192);
    expect(toolCalls).toEqual(['write_file']);
    const toolResultMessage = JSON.stringify(bodies[1]?.messages ?? []);
    expect(toolResultMessage).toContain('hit the per-turn output token cap');
    expect(toolResultMessage).toContain('max_tokens=8192');
    expect(toolResultMessage).toContain('replace_in_file');
    expect(warnings.some((w) => w.includes('output-token cap'))).toBe(true);
  });

  it('steers a cap-truncated insert_at_marker whose arguments never parsed', async () => {
    // The Vampire Survivors overhaul incident: qwen3.8-27b spent all 16384
    // tokens of its `thinking-coding` cap inside one tool call's arguments,
    // so the args JSON never parsed and the call arrived sanitized to `{}`.
    // Two gaps compounded: the cap hint required `args.content` (erased by
    // that same sanitization) and `insert_at_marker` wasn't recognized as
    // payload-carrying at all. The model got "malformed JSON — emit one new
    // compact call", retried the whole-file rewrite twice more, and the user
    // saw no warning naming the cap.
    const bodies: Array<{
      max_tokens?: number;
      messages?: Array<{ role: string; content?: string | null }>;
    }> = [];
    const toolCalls: string[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      if (bodies.length === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_cut_insert',
                      type: 'function',
                      function: {
                        name: 'insert_at_marker',
                        // Cut mid-arguments: no closing quote, no closing
                        // brace. `path` is still readable in the prefix.
                        arguments:
                          '{"path":"index.html","marker":"</script>","content":"' +
                          '<script>class Projectile { update(dt) { this.x += this.vx * ',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ index: 0, finish_reason: 'length' }],
            usage: { prompt_tokens: 33000, completion_tokens: 16384 },
          },
          '[DONE]',
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'Switching to targeted edits.' } }] },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 34000, completion_tokens: 20 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://ds4.test',
      includeUsageInStream: true,
    });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'qwen3.8-27b-q4',
      tuning: {
        sampling: { maxTokens: 16384 },
        reasoning: {},
        output: {},
        promptTags: {},
        wasThinking: false,
      },
    });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () =>
        ['insert_at_marker', 'replace_in_file', 'replace_lines', 'read_file'].map((name) => ({
          name,
          description: `${name} tool`,
          parameters: { type: 'object' },
        })),
      hasTool: () => true,
      callTool: async (name: string) => {
        toolCalls.push(name);
        return 'unexpected dispatch';
      },
    };
    const warnings: string[] = [];
    session.onWarning?.((msg) => warnings.push(msg));

    await expect(
      session.sendAndWait('The bullets do not hurt the vampires and the graphics are basic.'),
    ).resolves.toBe('Switching to targeted edits.');

    expect(bodies).toHaveLength(2);
    // Sanitized args are never dispatched — the loop short-circuits to an
    // ERROR result, which is what the hint attaches to.
    expect(toolCalls).toEqual([]);
    const toolResultMessage =
      (bodies[1]?.messages ?? []).find((m) => m.role === 'tool')?.content ?? '';
    expect(toolResultMessage).toContain('hit the per-turn output token cap');
    expect(toolResultMessage).toContain('max_tokens=16384');
    // Path recovered from the unparseable prefix, so the steer can name
    // the file instead of a placeholder.
    expect(toolResultMessage).toContain('replace_in_file(path="index.html"');
    expect(warnings.some((w) => w.includes('output-token cap'))).toBe(true);
    expect(warnings.some((w) => w.includes('insert_at_marker'))).toBe(true);
  });

  it('does not steer an over-cap write_artifact at edit tools the turn never wired', async () => {
    // The PR-review scope-step incident: a craftbook step needed a 25 KB
    // derived JSON artifact under a 6144-token cap on a writes-off project,
    // so the only payload tool wired was `write_artifact`. The hint named
    // `replace_in_file` / `replace_lines` unconditionally — absent from the
    // roster AND pointed at the wrong drawer — so the model spent a whole
    // turn planning a six-turn replace sequence and the task died.
    const bodies: Array<{
      max_tokens?: number;
      messages?: Array<{ role: string; content?: string | null }>;
    }> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      if (bodies.length === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_cut_artifact',
                      type: 'function',
                      function: {
                        name: 'write_artifact',
                        arguments:
                          '{"path":"pr-review/batches.json","content":"[{\\"batchNumber\\":1,' +
                          '\\"start\\":1,\\"end\\":25,\\"paths\\":[\\"packages/core/src/schemas/',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ index: 0, finish_reason: 'length' }],
            usage: { prompt_tokens: 86000, completion_tokens: 6144 },
          },
          '[DONE]',
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'Reporting the blocker.' } }] },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 87000, completion_tokens: 20 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://ds4.test',
      includeUsageInStream: true,
    });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'qwen3.8-27b-q4',
      tuning: {
        sampling: { maxTokens: 6144 },
        reasoning: {},
        output: {},
        promptTags: {},
        wasThinking: false,
      },
    });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () =>
        [
          'write_artifact',
          'read_artifact',
          'list_artifacts',
          'write_task_note',
          'set_task_status',
        ].map((name) => ({
          name,
          description: `${name} tool`,
          parameters: { type: 'object' },
        })),
      hasTool: () => true,
      callTool: async () => 'unexpected dispatch',
    };

    await expect(session.sendAndWait('Publish the fanout batches.')).resolves.toBe(
      'Reporting the blocker.',
    );

    const toolResultMessage =
      (bodies[1]?.messages ?? []).find((m) => m.role === 'tool')?.content ?? '';
    expect(toolResultMessage).toContain('hit the per-turn output token cap');
    expect(toolResultMessage).toContain('max_tokens=6144');
    expect(toolResultMessage).toContain('pr-review/batches.json');
    expect(toolResultMessage).not.toContain('replace_in_file');
    expect(toolResultMessage).not.toContain('replace_lines');
    expect(toolResultMessage).toContain('No incremental edit tool is wired this turn');
    // Routed to the honest exit, using the task tools that ARE wired.
    expect(toolResultMessage).toContain('write_task_note');
    expect(toolResultMessage).toContain('set_task_status');
  });

  it('gate-surgical-edit turns get a low-temp patch-only surface on the first move', async () => {
    // The gate-escalation stage-1 nudge (GATE_TARGETED_EDIT marker) must
    // reshape the turn immediately — no read precondition — to the
    // surgical pair at repair sampling. Before this mode the nudge ran as
    // a plain chat turn (the B2 gap).
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_patch',
                    type: 'function',
                    function: {
                      name: 'replace_in_file',
                      arguments: '{"path":"index.html","find":"<p>x</p>","replace":"<p>y</p>"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'tinyllama',
      externalTools: [
        'write_file',
        'read_file',
        'replace_in_file',
        'replace_lines',
        'validate',
      ].map((name) => ({
        name,
        description: `${name} tool`,
        parameters: { type: 'object', additionalProperties: true },
      })),
    });
    await session.sendAndWait(
      'GATE_TARGETED_EDIT: Continue. Your last edits did not move the gate — the same checks fail after each attempt. The file `index.html` EXISTS but fails exactly these checks:\n\n- index.html failed the html-game check\n\nFix the FIRST failure above with the smallest targeted edit — use replace_in_file on the exact section the check names. Do NOT recreate the file, do NOT re-read everything, and do NOT reply that you already finished.',
    );

    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.8);
    expect(body.max_tokens).toBe(2048);
    const toolNames = (body.tools as Array<{ function?: { name?: string } }>).map(
      (t) => t.function?.name,
    );
    expect(toolNames.sort()).toEqual(['replace_in_file', 'replace_lines']);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)?.content).toContain('[Local-model gate patch mode:');
  });

  it('uses DeepSeek thinking-off fields for ds4-shaped constrained turns', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"index.html","content":"<!doctype html>"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://ds4.test',
      disableThinkingRequestShape: 'deepseek',
    });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'deepseek-v4-flash-284b-q2',
      tuning: {
        sampling: { maxTokens: 8192 },
        reasoning: {},
        output: {},
        promptTags: {},
        wasThinking: false,
      },
      externalTools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });

    await session.sendAndWait(
      'First move: create the workspace deliverable at workspace/index.html',
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0]?.think).toBe(false);
    expect(bodies[0]?.thinking).toEqual({ type: 'disabled' });
    expect(bodies[0]?.max_tokens).toBe(8192);
  });

  it('uses GPT-OSS reasoning_effort=low for constrained turns', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"index.html","content":"<!doctype html>"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://gpt-oss.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'gpt-oss-20b-q4',
      externalTools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });

    await session.sendAndWait(
      'First move: create the workspace deliverable at workspace/index.html',
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.chat_template_kwargs).toEqual({
      enable_thinking: false,
      reasoning_effort: 'low',
    });
  });

  it('downgrades a manifest-declared reasoning depth dial on constrained turns, for templates that have no enable_thinking to honor', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"index.html","content":"<!doctype html>"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://glimmer.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'muse-glimmer-30b-q4',
      tuning: {
        sampling: {},
        reasoning: { templateKwargs: { reasoning_strength: 'high' } },
        output: {},
        promptTags: {},
        wasThinking: false,
      },
      externalTools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });

    await session.sendAndWait(
      'First move: create the workspace deliverable at workspace/index.html',
    );

    expect(bodies).toHaveLength(1);
    // `high` here is what tripped the immediate-write guard in the wild.
    expect(bodies[0]?.chat_template_kwargs).toEqual({
      enable_thinking: false,
      reasoning_strength: 'low',
    });
  });

  it('uses concise direct-edit mode for existing source edit turns and stops after mutation', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let patched = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length > 1) {
        throw new Error('existing source edit should stop after the first successful mutation');
      }
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_patch',
                    type: 'function',
                    function: {
                      name: 'replace_in_file',
                      arguments:
                        '{"path":"index.html","find":"renderTasks();","replace":"applyPriorityFilter();\\nrenderTasks();"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ index: 0, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'qwen' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'replace_in_file' || name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'replace_in_file') {
          patched = true;
          return 'replaced text';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        'Phase 2: modify the existing Launch Board codebase in `index.html`, do not start over. Use workspace `replace_in_file` or `write_file` to add a visible priority filter while preserving the board.',
      ),
    ).resolves.toBe('');

    expect(patched).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.max_tokens).toBe(2048);
    expect(bodies[0]?.tool_choice).toBe('required');
    expect(JSON.stringify(bodies[0])).toContain('enable_thinking');
    expect(JSON.stringify(bodies[0])).toContain('false');
    const messages = bodies[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)?.content).toContain('[Local-model edit mode:');
    expect(messages.at(-1)?.content).toContain('newest user/scenario message');
  });

  it('ends the turn after ask_user_question (no second generation request)', async () => {
    // The bug this pins: after the model posts a question, the loop used to
    // issue ANOTHER /v1/chat/completions request (to let the model respond to
    // the tool result). If that request wedges — engine idle-unloaded, slow
    // startup — the turn hangs in-flight forever (the "6000-second stuck
    // session"). The question is registered; its answer arrives as the next
    // user message, so the turn must END here. We assert the engine saw
    // exactly ONE request.
    let requestCount = 0;
    let askCalled = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_ask',
                      type: 'function',
                      function: {
                        name: 'ask_user_question',
                        arguments: '{"prompt":"Where is missionObjectives.md?"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ index: 0, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 12, completion_tokens: 6 },
          },
          '[DONE]',
        ]);
      }
      // A second request means the loop wrongly continued past the question.
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'should not run' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'tinyllama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'ask_user_question', description: 'Ask the user.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'ask_user_question',
      callTool: async (name: string) => {
        if (name === 'ask_user_question') {
          askCalled = true;
          return '[question card posted] END YOUR TURN HERE — the answer arrives as the next message.';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await session.sendAndWait('Check the project status and ask me if you need a decision.');

    expect(askCalled).toBe(true);
    expect(requestCount).toBe(1);
  });

  it('ends a lean game turn immediately after a successful terminal action tool', async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_move',
                    type: 'function',
                    function: {
                      name: 'make_move',
                      arguments:
                        '{"from":"b6","to":"c5","moveThought":"Center pressure — your turn."}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ index: 0, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'Play from the current board.',
      model: 'qwen',
      terminalToolPolicy: {
        toolNames: ['make_move'],
        closingArg: 'moveThought',
        fallbackText: 'Move made — your turn.',
      },
    });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'make_move', description: 'Play a move.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'make_move',
      callTool: async () => 'run move-1 — status: ok',
    };

    const reply = await session.sendAndWait('Take your turn.');

    expect(reply).toBe('Center pressure — your turn.');
    expect(requestCount).toBe(1);
  });

  it('narrows existing source edit turns to patch tools after reading the file', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let patched = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
        tool_choice?: unknown;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        expect(body.tools?.map((entry) => entry.function.name).sort()).toEqual([
          'read_file',
          'replace_in_file',
          'replace_lines',
          'write_file',
        ]);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"lib/paginate.mjs"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ index: 0, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          },
          '[DONE]',
        ]);
      }
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_patch',
                    type: 'function',
                    function: {
                      name: 'replace_lines',
                      arguments:
                        '{"path":"lib/paginate.mjs","startLine":25,"endLine":25,"content":"const start = options.cursor == null ? 0 : decodeCursor(options.cursor);"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ index: 0, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 30, completion_tokens: 7 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'qwen' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' ||
        name === 'replace_in_file' ||
        name === 'replace_lines' ||
        name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'read_file') {
          return '24→ // Resume one past the cursor position.\\n25→ const start = options.cursor == null ? 0 : decodeCursor(options.cursor) + 1;';
        }
        if (name === 'replace_lines') {
          patched = true;
          return 'replaced lines';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(session.sendAndWait(SYMPTOM_DEBUG_KICKOFF_MESSAGE)).resolves.toBe('');

    expect(patched).toBe(true);
    expect(bodies).toHaveLength(2);
    const secondToolNames = bodies[1]?.tools?.map((entry) => entry.function.name).sort();
    expect(secondToolNames).toEqual(['replace_in_file', 'replace_lines']);
    expect(JSON.stringify(bodies[1]?.messages)).toContain('[Local-model patch mode:');
    expect(JSON.stringify(bodies[1]?.messages)).toContain('newest named requirement');
  });

  it('keeps the first Gemma scenario repair optional, then forces a tool after a no-mutation miss', async () => {
    const bodies: Array<{
      tool_choice?: unknown;
      chat_template_kwargs?: Record<string, unknown>;
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let requestCount = 0;
    let patched = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        tool_choice?: unknown;
        chat_template_kwargs?: Record<string, unknown>;
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"index.html"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  content: 'I should preserve the existing page and patch only the failing line.',
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'stop' }] },
          '[DONE]',
        ]);
      }
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_patch',
                    type: 'function',
                    function: {
                      name: 'replace_lines',
                      arguments:
                        '{"path":"index.html","startLine":10,"endLine":10,"content":"<button id=\\"nextStep\\">Next step</button>"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'gemma4-e4b-q4',
      profile: {
        catalogId: 'gemma4-e4b-q4',
        tier: 'small',
        style: { family: 'gemma', reasoningFormat: 'channel', toolCallFormat: 'function-call' },
        behaviors: [],
      },
      tuning: {
        sampling: {},
        reasoning: { enableThinking: true },
        output: {},
        promptTags: {},
        wasThinking: true,
      },
    });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'validate', description: 'Validate a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' ||
        name === 'validate' ||
        name === 'replace_in_file' ||
        name === 'replace_lines' ||
        name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'read_file') {
          return '1→ <form>\\n10→ <button id="continue">Continue</button>';
        }
        if (name === 'replace_lines') {
          patched = true;
          return 'replaced lines';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `index.html` and the success criteria aren't met yet.\n" +
          'Signals that did not fire: missing next-step button.\n' +
          'Exact patch candidate(s): replace_lines({ path: "index.html", startLine: 10, endLine: 10, content: "<button id=\\"nextStep\\">Next step</button>" }).',
      ),
    ).resolves.toBe('');

    expect(patched).toBe(true);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.tool_choice).toBeUndefined();
    expect(bodies[0]?.chat_template_kwargs?.enable_thinking).toBe(true);
    expect(bodies[1]?.tool_choice).toBeUndefined();
    expect(bodies[1]?.chat_template_kwargs?.enable_thinking).toBe(true);
    expect(bodies[2]?.tool_choice).toBe('required');
    expect(bodies[2]?.chat_template_kwargs?.enable_thinking).toBe(false);
    expect(bodies[0]?.tools?.map((entry) => entry.function.name).sort()).toEqual([
      'read_file',
      'replace_in_file',
      'replace_lines',
      'validate',
    ]);
    expect(bodies[1]?.tools?.map((entry) => entry.function.name).sort()).toEqual([
      'replace_in_file',
      'replace_lines',
    ]);
    expect(bodies[2]?.tools?.map((entry) => entry.function.name).sort()).toEqual([
      'replace_in_file',
      'replace_lines',
    ]);
  });

  it('forces a narrowed Gemma existing-source retry after a no-mutation miss', async () => {
    const bodies: Array<{
      tool_choice?: unknown;
      chat_template_kwargs?: Record<string, unknown>;
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let requestCount = 0;
    let patched = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"src/store.ts"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: { content: 'I should make the smallest safe change to the store.' },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'stop' }] },
          '[DONE]',
        ]);
      }
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_patch',
                    type: 'function',
                    function: {
                      name: 'replace_in_file',
                      arguments:
                        '{"path":"src/store.ts","find":"user.name","replace":"`${user.firstName} ${user.lastName}`"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'gemma4-e4b-q4',
      profile: {
        catalogId: 'gemma4-e4b-q4',
        tier: 'small',
        style: { family: 'gemma', reasoningFormat: 'channel', toolCallFormat: 'function-call' },
        behaviors: [],
      },
      tuning: {
        sampling: {},
        reasoning: { enableThinking: true },
        output: {},
        promptTags: {},
        wasThinking: true,
      },
    });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' ||
        name === 'replace_in_file' ||
        name === 'replace_lines' ||
        name === 'write_file',
      callTool: async (name: string) => {
        if (name === 'read_file') return '1→ export function display(user) { return user.name; }';
        if (name === 'replace_in_file') {
          patched = true;
          return 'replaced text';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        '[eval recovery]\nYour previous turn aborted. Repair `src/store.ts` with the smallest targeted edit and preserve the existing API. Read the current file once, then patch the syntax error in place; do not rewrite the complete file.',
      ),
    ).resolves.toBe('');

    expect(patched).toBe(true);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.tool_choice).toBeUndefined();
    expect(bodies[0]?.chat_template_kwargs?.enable_thinking).toBe(true);
    expect(bodies[1]?.tool_choice).toBeUndefined();
    expect(bodies[1]?.chat_template_kwargs?.enable_thinking).toBe(true);
    expect(bodies[2]?.tool_choice).toBe('required');
    expect(bodies[2]?.chat_template_kwargs?.enable_thinking).toBe(false);
    expect(bodies[1]?.tools?.map((entry) => entry.function.name).sort()).toEqual([
      'replace_in_file',
      'replace_lines',
    ]);
    expect(bodies[2]?.tools?.map((entry) => entry.function.name).sort()).toEqual([
      'replace_in_file',
      'replace_lines',
    ]);
  });

  it('recovers existing source edit prose into a corrective mutation nudge', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let requestCount = 0;
    let patched = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  content: `I can make the change by preserving the existing implementation and carefully patching the current render path. ${'analysis '.repeat(300)}`,
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'stop' }] },
          '[DONE]',
        ]);
      }
      expect(body.messages.at(-1)?.role).toBe('user');
      expect(body.messages.at(-1)?.content).toContain('without changing any workspace file');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_patch',
                    type: 'function',
                    function: {
                      name: 'replace_in_file',
                      arguments:
                        '{"path":"index.html","find":"renderTasks();","replace":"renderTasks(filterPriority);"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'qwen' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'replace_in_file' || name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'replace_in_file') {
          patched = true;
          return 'replaced text';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        'Phase 2: modify the existing Launch Board codebase in `index.html`, do not start over. Use workspace `replace_in_file` or `write_file` to add a visible priority filter while preserving the board.',
      ),
    ).resolves.toBe('');

    expect(patched).toBe(true);
    expect(bodies).toHaveLength(2);
  });

  it('salvages leaked Gemma-native tool-call envelopes as external tool calls', async () => {
    globalThis.fetch = (async () => {
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                content: `<|tool_call>call:start_project{
  name: "Tic-Tac-Toe Game",
  about: "Browser game project.",
  missionObjectives: [
    "The game must be playable.",
    "The game must show a winner."
  ],
  taskDescription: "Build workspace/index.html."
}<tool_call|>`,
              },
            },
          ],
        },
        {
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'gemma4-e4b',
      externalTools: [
        {
          name: 'start_project',
          description: 'Create a project.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });

    const text = await session.sendAndWait('start');
    expect(text).toBe('');
    expect(session.capturedToolCalls?.()).toHaveLength(1);
    const call = session.capturedToolCalls?.()[0];
    expect(call?.name).toBe('start_project');
    expect(JSON.parse(call?.arguments ?? '{}')).toEqual({
      name: 'Tic-Tac-Toe Game',
      about: 'Browser game project.',
      missionObjectives: ['The game must be playable.', 'The game must show a winner.'],
      taskDescription: 'Build workspace/index.html.',
    });
  });

  it('repairs malformed structured write_file args before capturing the tool call', async () => {
    globalThis.fetch = (async () => {
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '"<!DOCTYPE html>\\n<html><body><div>Player X\\\'s Turn</div><script>document.body.onclick=()=>{};</script></body></html>\\n\\"\\"\\", path: \\"index.html\\" });\\n<|channel>thought',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ index: 0, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'gemma4-12b-q4',
      externalTools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });

    const text = await session.sendAndWait('write it');
    expect(text).toBe('');
    const call = session.capturedToolCalls?.()[0];
    expect(call?.name).toBe('write_file');
    const args = JSON.parse(call?.arguments ?? '{}');
    expect(args.path).toBe('index.html');
    expect(args.content).toContain("<div>Player X's Turn</div>");
    expect(args.content).not.toContain('<|channel>');
  });

  it('does not repair and execute a malformed write_file prefix at the output limit', async () => {
    globalThis.fetch = (async () => {
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_truncated_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"postmortem.md","content":"# Postmortem\\n\\n| Action | Owner |\\n| Add alert |',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ index: 0, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 4096 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'qwen3.8-27b-q4',
      externalTools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });

    await session.sendAndWait('write it');
    const call = session.capturedToolCalls?.()[0];
    expect(call).toMatchObject({ name: 'write_file', arguments: '{}' });
  });

  it('recognizes saved invalid first drafts as recoverable immediate writes', () => {
    expect(
      isRecoverableImmediateFileWriteError(
        'ERROR: inline JS does not parse (Unexpected token ]).\n\nInvalid first draft index.html was saved anyway so you can continue with read_file({ path: "index.html" }) and then repair it with replace_in_file(...) instead of starting over.',
      ),
    ).toBe(true);
    expect(
      isRecoverableImmediateFileWriteError(
        'ERROR: inline JS does not parse (Unexpected token ]).\n\nExisting index.html was left untouched to preserve the last complete version.',
      ),
    ).toBe(false);
    expect(isRecoverableImmediateFileWriteError('Wrote index.html')).toBe(false);
  });

  it('only treats JSON-complete structured write_file HTML as salvageable', () => {
    const completeHtml =
      '<!DOCTYPE html>\n' +
      '<html><head><title>Tic Tac Toe</title></head><body>' +
      '<main><h1>Tic Tac Toe</h1><div id="status">Player X turn</div></main>' +
      '<script>document.body.addEventListener("click", () => {});</script></body></html>';
    const substantialPartialHtml = `<!DOCTYPE html>\n<html><head><title>Tic Tac Toe</title></head><body><main><h1>Tic Tac Toe</h1><div id="status">Player X turn</div><button>Reset</button></main><script>${'const board = Array(9).fill("");\n'.repeat(170)}`;

    expect(
      hasSalvageableImmediateStructuredWriteArgs(
        JSON.stringify({ path: 'index.html', content: completeHtml }),
      ),
    ).toBe(true);
    expect(
      hasSalvageableImmediateStructuredWriteArgs(
        `${JSON.stringify({ path: 'index.html' }).slice(0, -1)},"content":${JSON.stringify(completeHtml)}`,
      ),
    ).toBe(false);
    expect(
      hasSalvageableImmediateStructuredWriteArgs(
        `{"path":"index.html","content":"${substantialPartialHtml}`,
      ),
    ).toBe(false);
    expect(
      hasSalvageableImmediateStructuredWriteArgs(
        '{"path":"index.html","content":"<html><body><script>const board = [];"',
      ),
    ).toBe(false);
    expect(
      hasSalvageableImmediateStructuredWriteArgs(
        '{"path":"notes.txt","content":"short non-html draft"}',
      ),
    ).toBe(false);
  });

  it('propagates 500s as clear errors', async () => {
    globalThis.fetch = stubFetch({
      '/v1/chat/completions': () =>
        new Response('model load failed', { status: 500, statusText: 'Internal Server Error' }),
    });
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    await expect(session.sendAndWait('hi')).rejects.toThrow(/returned 500/);
  });

  it('retries strict user/assistant templates with flattened tool results', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let callCount = 0;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      bodies.push(body);
      callCount += 1;
      if (callCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_echo',
                      type: 'function',
                      function: { name: 'echo_tool', arguments: '{"value":"ok"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (callCount === 2) {
        expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
        return new Response(
          JSON.stringify({
            error: {
              message:
                'Jinja Exception: Conversation roles must alternate user/assistant/user/assistant/...',
            },
          }),
          { status: 500, statusText: 'Internal Server Error' },
        );
      }
      expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
      expect(body.messages.at(-1)?.content).toContain('Tool result for echo_tool');
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'done' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'mistral-7b-q4' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'echo_tool', description: 'Echo.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'echo_tool',
      callTool: async (_name: string, args: Record<string, unknown>) =>
        `echoed ${String(args.value)}`,
    };

    await expect(session.sendAndWait('use the tool')).resolves.toBe('done');
    expect(bodies).toHaveLength(3);
  });

  it('does not accept read-only prose as completion for scenario file repairs', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let requestCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"src/app.js"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        expect(body.messages.at(-1)?.role).toBe('tool');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  content:
                    'I replaced the broken render path in `src/app.js`; the seed tasks now render.',
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'stop' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 3) {
        expect(body.messages.at(-1)?.role).toBe('user');
        expect(body.messages.at(-1)?.content).toContain('no workspace file changed');
        expect(body.messages.at(-1)?.content).toContain('one more targeted read');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: '{"path":"src/app.js","content":"renderBoard();"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'patched src/app.js' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_file' || name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'wrote file';
        }
        return 'export function renderBoard() {}';
      },
    };

    await expect(
      session.sendAndWait(
        '[runtime check] I opened `index.html` in a headless browser. 1 assertion(s) failed: seed-tasks-render. Read `index.html`, find the specific code, and patch with `replace_in_file` or `write_file`.',
      ),
    ).resolves.toBe('');
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it('allows one targeted read after a scenario repair no-mutation nudge', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let requestCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_app',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"src/app.js"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  content:
                    'The entrypoint looks right. I need to inspect the state module before patching.',
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'stop' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 3) {
        expect(body.messages.at(-1)?.role).toBe('user');
        expect(body.messages.at(-1)?.content).toContain('one more targeted read');
        expect(body.messages.at(-1)?.content).toContain('`src/app.js`');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_state',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"src/state.js"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 4) {
        expect(body.messages.at(-1)?.role).toBe('tool');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments:
                          '{"path":"src/state.js","content":"export function loadState(){ return seedTasks(); }"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'patched src/state.js' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_file' || name === 'write_file',
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'wrote file';
        }
        return args.path === 'src/app.js'
          ? 'loadState();\nrenderBoard();'
          : 'export function loadState() { return []; }';
      },
    };

    await expect(
      session.sendAndWait(
        '[runtime check] I opened `index.html` in a headless browser. 1 assertion(s) failed: seed-tasks-render. Read `index.html`, find the specific code, and patch with `replace_in_file` or `write_file`.',
      ),
    ).resolves.toBe('');
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(4);
  });

  it('completes an exact bounded provenance-read repair before exposing mutations', async () => {
    const requiredPaths = [
      'memo-product.md',
      'memo-engineering.md',
      'finance.csv',
      'org.md',
      'memo-oldplan.md',
    ];
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{
        function: {
          name: string;
          parameters?: {
            properties?: {
              path?: { enum?: string[] };
              startLine?: { type?: string; minimum?: number; maximum?: number };
              endLine?: { type?: string; minimum?: number; maximum?: number };
            };
          };
        };
      }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;
      if (requestCount <= requiredPaths.length) {
        const expectedPath = requiredPaths[requestCount - 1]!;
        expect(body.tools?.map((tool) => tool.function.name)).toEqual(['read_file']);
        expect(body.tools?.[0]?.function.parameters?.properties?.path?.enum).toEqual(
          requiredPaths.slice(requestCount - 1),
        );
        expect(body.tools?.[0]?.function.parameters?.properties?.startLine).toMatchObject({
          type: 'integer',
          minimum: 1,
        });
        expect(body.tools?.[0]?.function.parameters?.properties?.endLine).toMatchObject({
          type: 'integer',
          minimum: 1,
        });
        expect(body.tool_choice).toBe('required');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_read_${requestCount}`,
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: expectedPath }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(body.tools?.map((tool) => tool.function.name)).toEqual(['write_file']);
      expect(body.tool_choice).toBe('required');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write_synthesis',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"synthesis.md","content":"# Grounded synthesis\\n\\nAll claims follow the newly read sources."}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_file' || name === 'write_file',
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'wrote synthesis.md';
        }
        return `observed source fields from ${String(args.path)}`;
      },
    };

    const prompt = [
      "[scenario check] I looked at `synthesis.md` and the success criteria aren't met yet.",
      'Specific failure: source-read provenance is missing.',
      'SOURCE_READ_REQUIRED: the final claims are not backed by successful, ordered source reads.',
      'First call read_file on memo-product.md, memo-engineering.md, finance.csv, org.md, and memo-oldplan.md.',
      'Then patch `synthesis.md` using only the values you observed in those files.',
      'The final claim-recording mutations must occur after their corresponding reads.',
      'Use replace_in_file or replace_lines for focused corrections; use write_file only when several sections need a coherent grounded rewrite.',
    ].join(' ');
    expect(extractPrerequisiteRepairReadPaths(prompt)).toEqual(requiredPaths);

    await expect(session.sendAndWait(prompt)).resolves.toBe('');
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(requiredPaths.length + 1);
  });

  it('pins post-read scenario patches to the checked target and rejects wrong-path mutations', async () => {
    const requiredPaths = ['runbook.md', 'state/services.json'];
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{
        function: {
          name: string;
          parameters?: { properties?: { path?: { enum?: string[] } } };
        };
      }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    const executedMutations: Array<{ name: string; path: unknown }> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;
      if (requestCount <= requiredPaths.length) {
        const expectedPath = requiredPaths[requestCount - 1]!;
        expect(body.tools?.map((tool) => tool.function.name)).toEqual(['read_file']);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_read_${requestCount}`,
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: expectedPath }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }

      const mutationTools = body.tools ?? [];
      expect(mutationTools.map((tool) => tool.function.name).sort()).toEqual([
        'append_to_file',
        'replace_in_file',
        'replace_lines',
        'write_file',
      ]);
      for (const tool of mutationTools) {
        expect(tool.function.parameters?.properties?.path?.enum).toEqual(['runlog.md']);
      }

      if (requestCount === 3) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_wrong_patch',
                      type: 'function',
                      function: {
                        name: 'replace_in_file',
                        arguments:
                          '{"path":"maintenance/runlog.md","find":"STEP 1","replace":"STEP 1\\n14 services"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }

      expect(body.messages.at(-1)?.role).toBe('tool');
      expect(body.messages.at(-1)?.content).toContain(
        'must patch exactly `runlog.md`, but you called replace_in_file for `maintenance/runlog.md`',
      );
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_correct_patch',
                    type: 'function',
                    function: {
                      name: 'replace_in_file',
                      arguments:
                        '{"path":"runlog.md","find":"STEP 1","replace":"STEP 1\\n14 services"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    const toolNames = [
      'read_file',
      'write_file',
      'append_to_file',
      'replace_in_file',
      'replace_lines',
    ];
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () =>
        toolNames.map((name) => ({
          name,
          description: `${name} tool`,
          parameters: { type: 'object' },
        })),
      hasTool: (name: string) => toolNames.includes(name),
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'read_file') return `observed ${String(args.path)}`;
        executedMutations.push({ name, path: args.path });
        return `patched ${String(args.path)}`;
      },
    };

    const prompt = [
      "[scenario check] I looked at `runlog.md` and the success criteria aren't met yet.",
      'Specific failure: STEP 1 is missing its observed verification value.',
      'POST_READ_MUTATION_TARGET: complete the required read_file calls first. After the final required read succeeds, mutate exactly `runlog.md` with the named write_file or patch operation.',
      'First use read_file on runbook.md and state/services.json.',
      'Then patch runlog.md with only the observed value.',
    ].join(' ');
    expect(extractPrerequisiteRepairReadPaths(prompt)).toEqual(requiredPaths);

    await expect(session.sendAndWait(prompt)).resolves.toBe('');
    expect(executedMutations).toEqual([{ name: 'replace_in_file', path: 'runlog.md' }]);
    expect(bodies).toHaveLength(4);
  });

  it('extracts before-edit rereads from scenario feedback', () => {
    const prompt = [
      "[scenario check] I looked at `src/machine.ts` and the success criteria aren't met yet.",
      'Before editing, re-read tests/machine.test.ts in full and then read the current src/machine.ts.',
      'Patch src/machine.ts against the API the frozen tests actually call.',
    ].join(' ');

    expect(extractPrerequisiteRepairReadPaths(prompt)).toEqual([
      'tests/machine.test.ts',
      'src/machine.ts',
    ]);
  });

  it('extracts prerequisite reads when the grounded mutation is phrased as record', () => {
    const prompt = [
      "[scenario check] I looked at `runlog.md` and the success criteria aren't met yet.",
      'STEP_1_SOURCE_PATCH: first read runbook.md and state/services.json, count the services array, then record the observed count under STEP 1 in runlog.md.',
    ].join(' ');

    expect(extractPrerequisiteRepairReadPaths(prompt)).toEqual([
      'runbook.md',
      'state/services.json',
    ]);
  });

  it('keeps provenance-read prose stalls bounded without weakening ordinary mutation guards', async () => {
    const bodies: Array<{
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: unknown;
    }> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      expect(body.tools?.map((tool) => tool.function.name)).toEqual(['read_file']);
      expect(body.tool_choice).toBe('required');
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I will inspect the sources carefully.' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_file' || name === 'write_file',
      callTool: async () => 'unused',
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `synthesis.md` and the success criteria aren't met yet. " +
          'SOURCE_READ_REQUIRED: ordered reads are missing. ' +
          'First call read_file on memo-product.md and memo-engineering.md. ' +
          'Then patch `synthesis.md` using only observed values.',
      ),
    ).rejects.toThrow(
      'prerequisite source-read repair ended without reading the remaining source(s) after 2 corrective nudge(s)',
    );
    expect(bodies).toHaveLength(3);
  });

  it('escalates repeated no-mutation scenario repair retries to write_file only', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let requestCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_app',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"index.html"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: { content: 'The error is on the submit handler line; I can patch it.' },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'stop' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 3) {
        expect(body.tools?.map((tool) => tool.function.name)).toContain('read_file');
        expect(body.messages.at(-1)?.content).toContain('one more targeted read');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: { content: 'I will now make the syntax fix.' },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'stop' }] },
          '[DONE]',
        ]);
      }
      expect(body.messages.at(-1)?.role).toBe('user');
      expect(body.messages.at(-1)?.content).toContain('Do not read again');
      const toolNames = body.tools?.map((tool) => tool.function.name) ?? [];
      expect(toolNames).not.toContain('read_file');
      expect(toolNames).not.toContain('validate');
      expect(toolNames).not.toContain('replace_in_file');
      expect(toolNames).toEqual(['write_file']);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_rewrite',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"index.html","content":"<!doctype html><script>renderBoard();</script>"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'validate', description: 'Validate a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' ||
        name === 'validate' ||
        name === 'replace_in_file' ||
        name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'wrote file';
        }
        return 'document.getElementById("addForm").addEventListener("submit", e => { renderBoard(); }});';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `index.html` and the success criteria aren't met yet. Specific failure: inline-js-parses: Inline JavaScript must parse cleanly while the app is monolithic. (missing ) after argument list). Read `index.html`, then use `replace_in_file` for exact bad text before trying a full `write_file`.",
      ),
    ).resolves.toBe('');
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(4);
  });

  it('uses a no-rewrite source repair surface for scenario source checks', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let patched = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      const toolNames = body.tools?.map((entry) => entry.function.name).sort();
      expect(toolNames).toEqual(['read_file', 'replace_in_file', 'replace_lines', 'validate']);
      expect(JSON.stringify(body.messages)).toContain('[Local-model source repair mode:');
      expect(JSON.stringify(body.messages)).toContain('newest named failing check');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_lines',
                    type: 'function',
                    function: {
                      name: 'replace_lines',
                      arguments:
                        '{"path":"index.html","startLine":46,"endLine":46,"content":"<input id=\\"dueDateInput\\" type=\\"date\\">"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'validate', description: 'Validate a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' ||
        name === 'validate' ||
        name === 'replace_in_file' ||
        name === 'replace_lines' ||
        name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'replace_lines') {
          patched = true;
          return 'replaced lines';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `index.html` and the success criteria aren't met yet. Signals that didn't fire: **due-date-input**, **due-summary**, **date-logic**. Patch the deliverable.",
      ),
    ).resolves.toBe('');

    expect(patched).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it('keeps write_file available for JSON data deliverable repairs', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      const toolNames = body.tools?.map((entry) => entry.function.name).sort();
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('replace_in_file');
      expect(JSON.stringify(body.messages)).toContain('[Local-model repair mode:');
      expect(JSON.stringify(body.messages)).not.toContain('[Local-model source repair mode:');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"out/customers.json","content":"[{\\"id\\":\\"A-001\\",\\"name\\":\\"Alice\\",\\"email\\":\\"alice@example.com\\",\\"signupDate\\":\\"2025-01-01\\"}]"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'validate', description: 'Validate a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' ||
        name === 'validate' ||
        name === 'replace_in_file' ||
        name === 'replace_lines' ||
        name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'wrote out/customers.json';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `out/customers.json` and the success criteria aren't met yet. Signals that did not fire: row-count. Rewrite the complete JSON array. Fast path: write scripts/clean_data.mjs, run it against the raw files, and have it write out/customers.json.",
      ),
    ).resolves.toBe('');

    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it('honors the manager direct-file clamp when the latest wording is not independently classifiable', async () => {
    let requestBody: {
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{
        function: {
          name: string;
          parameters?: { properties?: { path?: { enum?: string[] } } };
        };
      }>;
      tool_choice?: unknown;
      temperature?: number;
    } | null = null;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as typeof requestBody;
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"records/attendees.csv","content":"id,email\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'llama',
      forceDirectFileWork: true,
      directFileWorkTargetPath: 'records/attendees.csv',
    });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_file' || name === 'write_file',
      callTool: async () => 'Wrote records/attendees.csv',
    };

    await expect(session.sendAndWait('Continue the assigned intake work.')).resolves.toBe('');

    expect(requestBody).not.toBeNull();
    expect(requestBody!.tool_choice).toBe('required');
    expect(requestBody!.temperature).toBe(0.2);
    expect(JSON.stringify(requestBody!.messages)).toContain('[Local-model file-work mode:');
    const writeTool = requestBody!.tools?.find((entry) => entry.function.name === 'write_file');
    expect(writeTool?.function.parameters?.properties?.path?.enum).toEqual([
      'records/attendees.csv',
    ]);
  });

  it('forces a direct file-work turn to write after read-only tools', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: unknown;
      max_tokens?: number;
    }> = [];
    let requestCount = 0;
    let readCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
        tool_choice?: unknown;
        max_tokens?: number;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        expect(body.tool_choice).toBe('required');
        expect(JSON.stringify(body.messages)).toContain('[Local-model file-work mode:');
        expect(JSON.stringify(body.messages)).toContain('[Local-model prerequisite-read mode:');
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['read_file']);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_a',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"notes/a.txt"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(body.max_tokens).toBe(4096);
      if (requestCount === 2) {
        expect(JSON.stringify(body.messages)).not.toContain('[Local-model write-now mode:');
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['read_file']);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_b',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"notes/b.txt"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(JSON.stringify(body.messages)).toContain('[Local-model write-now mode:');
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(body.tool_choice).toBe('required');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out/summary.md","content":"# Summary\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'read_file') {
          readCount += 1;
          return 'source note';
        }
        if (name === 'write_file') {
          wroteFile = true;
          return 'wrote out/summary.md';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        'Please read notes/a.txt and notes/b.txt, then produce the deliverable out/summary.md as a concise markdown summary.',
      ),
    ).resolves.toBe('');

    expect(readCount).toBe(2);
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it('keeps direct file-work alive after writing a helper script until the target is produced', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string; description?: string } }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let wroteScript = false;
    let ranScript = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string; description?: string } }>;
        tool_choice?: unknown;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"notes/source.txt","raw":true}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(JSON.stringify(body.messages)).toContain('[Local-model write-now mode:');
      if (requestCount === 2) {
        expect(JSON.stringify(body.messages)).toContain('[Local-model data-transform mode:');
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
        expect(body.tool_choice).toBe('required');
        expect(
          (
            body.tools?.[0]?.function as unknown as {
              parameters?: { properties?: { path?: { enum?: string[] } } };
            }
          ).parameters?.properties?.path?.enum,
        ).toEqual(['scripts/clean_data.mjs']);
        expect(body.tools?.[0]?.function.description?.length ?? 0).toBeLessThan(240);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_script_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments:
                          '{"path":"scripts/clean_data.mjs","content":"import { writeFileSync } from \\"node:fs\\";\\nwriteFileSync(\\"out/customers.json\\", \\"[]\\\\n\\");\\n"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(JSON.stringify(body.messages)).toContain('The helper script was written');
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['run_nodejs_script']);
      expect(body.tool_choice).toBe('required');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_run_script',
                    type: 'function',
                    function: {
                      name: 'run_nodejs_script',
                      arguments: '{"path":"scripts/clean_data.mjs"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'read_file') return 'id,email\\nA-001,Alice@example.com';
        if (name === 'write_file') {
          expect(args.path).toBe('scripts/clean_data.mjs');
          wroteScript = true;
          return 'Wrote scripts/clean_data.mjs';
        }
        if (name === 'run_nodejs_script') {
          ranScript = true;
          return '✓ scripts/clean_data.mjs completed (exit 0)';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        'Please normalize data/raw/customers.csv and produce the output file out/customers.json. You may write a Node script and run it.',
      ),
    ).resolves.toBe('');

    expect(wroteScript).toBe(true);
    expect(ranScript).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it('keeps scenario-check derived-data repairs in the helper execution loop', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{
        function: {
          name: string;
          parameters?: { properties?: { path?: { enum?: string[] } } };
        };
      }>;
    }> = [];
    let requestCount = 0;
    let readCount = 0;
    let wroteScript = false;
    let ranScript = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        expect(JSON.stringify(body.messages)).toContain('[Local-model data-transform mode:');
        expect(JSON.stringify(body.messages)).not.toContain('[Local-model repair mode:');
        expect(JSON.stringify(body.messages)).toContain('never `require(...)`');
        expect(JSON.stringify(body.messages)).toContain('plain JavaScript');
        expect(JSON.stringify(body.messages)).toContain('TypeScript annotations');
        expect(JSON.stringify(body.messages)).toContain('pattern must not match an empty string');
        expect(JSON.stringify(body.messages)).toContain('parent directory recursively');
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
        expect(body.tools?.[0]?.function.parameters?.properties?.path?.enum).toEqual([
          'scripts/clean_data.mjs',
        ]);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_script_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments:
                          '{"path":"scripts/clean_data.mjs","content":"import { readFileSync, writeFileSync } from \\"node:fs\\";\\nconst raw = readFileSync(\\"data/raw/customers.csv\\", \\"utf8\\");\\nwriteFileSync(\\"out/customers.json\\", JSON.stringify([{ raw }]));\\n"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['run_nodejs_script']);
      expect(body.tools?.[0]?.function.parameters?.properties?.path?.enum).toEqual([
        'scripts/clean_data.mjs',
      ]);
      if (requestCount === 2) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_wrong_script',
                      type: 'function',
                      function: {
                        name: 'run_nodejs_script',
                        arguments: '{"path":"scripts/nonexistent_helper.mjs"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(JSON.stringify(body.messages)).toContain('must run exactly `scripts/clean_data.mjs`');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_run_script',
                    type: 'function',
                    function: {
                      name: 'run_nodejs_script',
                      arguments: '{"path":"scripts/clean_data.mjs"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'read_file') {
          readCount += 1;
          return 'unexpected read';
        }
        if (name === 'write_file') {
          expect(args.path).toBe('scripts/clean_data.mjs');
          wroteScript = true;
          return 'Wrote scripts/clean_data.mjs';
        }
        if (name === 'run_nodejs_script') {
          expect(args.path).toBe('scripts/clean_data.mjs');
          ranScript = true;
          return 'scripts/clean_data.mjs completed (exit 0)';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        '[scenario check] The existing out/customers.json still fails dates-iso. DATA_WRANGLE_COMPLETE_REBUILD: clean up data/raw/customers.csv and produce out/customers.json. If you write a Node script, have the script read the CSV with fs.readFileSync and write out/customers.json with fs.writeFileSync. Do not hand-type the rows.',
      ),
    ).resolves.toBe('');

    expect(readCount).toBe(0);
    expect(wroteScript).toBe(true);
    expect(ranScript).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it('rewrites a helper after execution failure and keeps no-tool recovery on the helper', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{
        function: {
          name: string;
          parameters?: { properties?: { path?: { enum?: string[] } } };
        };
      }>;
    }> = [];
    let requestCount = 0;
    let helperWriteAttempts = 0;
    let helperRunAttempts = 0;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1 || requestCount === 4) {
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
        expect(body.tools?.[0]?.function.parameters?.properties?.path?.enum).toEqual([
          'scripts/clean_data.mjs',
        ]);
        if (requestCount === 4) {
          const latestMessage = body.messages.at(-1)?.content ?? '';
          expect(latestMessage).toContain('The helper script ran and FAILED');
          expect(latestMessage).toContain('ReferenceError: require is not defined');
          expect(latestMessage).toContain('rewriting exactly `scripts/clean_data.mjs`');
          expect(latestMessage).not.toContain('write_file` for the output file');
        }
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: requestCount === 1 ? 'call_bad_helper' : 'call_fixed_helper',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments:
                          requestCount === 1
                            ? '{"path":"scripts/clean_data.mjs","content":"const fs = require(\\"fs\\");\\nfs.writeFileSync(\\"out/customers.json\\", \\"[]\\n\\");\\n"}'
                            : '{"path":"scripts/clean_data.mjs","content":"import fs from \\"node:fs\\";\\nfs.mkdirSync(\\"out\\", { recursive: true });\\nfs.writeFileSync(\\"out/customers.json\\", \\"[]\\n\\");\\n"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2 || requestCount === 5) {
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['run_nodejs_script']);
        expect(body.tools?.[0]?.function.parameters?.properties?.path?.enum).toEqual([
          'scripts/clean_data.mjs',
        ]);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: requestCount === 2 ? 'call_bad_run' : 'call_good_run',
                      type: 'function',
                      function: {
                        name: 'run_nodejs_script',
                        arguments: '{"path":"scripts/clean_data.mjs"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(requestCount).toBe(3);
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(body.tools?.[0]?.function.parameters?.properties?.path?.enum).toEqual([
        'scripts/clean_data.mjs',
      ]);
      const latestMessage = body.messages.at(-1)?.content ?? '';
      expect(latestMessage).toContain('The helper script ran and FAILED');
      expect(latestMessage).toContain('ReferenceError: require is not defined');
      // A prose-only repair response exercises the bounded no-tool
      // corrective; request 4 must remain aligned with the helper schema.
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I should fix the helper first.' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'write_file') {
          expect(args.path).toBe('scripts/clean_data.mjs');
          helperWriteAttempts += 1;
          return 'Wrote scripts/clean_data.mjs';
        }
        if (name === 'run_nodejs_script') {
          expect(args.path).toBe('scripts/clean_data.mjs');
          helperRunAttempts += 1;
          return helperRunAttempts === 1
            ? '✗ scripts/clean_data.mjs failed (exit 1)\nstderr:\nReferenceError: require is not defined in ES module scope'
            : '✓ scripts/clean_data.mjs completed (exit 0)';
        }
        return `ERROR: unexpected ${name}`;
      },
    };

    await expect(
      session.sendAndWait(
        'Normalize data/raw/customers.csv into out/customers.json. Have a Node script read the CSV with fs.readFileSync and write out/customers.json with fs.writeFileSync. Do not hand-type the rows.',
      ),
    ).resolves.toBe('');

    expect(helperWriteAttempts).toBe(2);
    expect(helperRunAttempts).toBe(2);
    expect(bodies).toHaveLength(5);
  });

  it('rejects a byte-identical helper rewrite after execution failure without rerunning it', async () => {
    const failedHelper =
      'import fs from "node:fs";\nconst re = /(?:[^,]*)(?:,|$)/g;\nwhile (re.exec("a,b")) {}\n';
    const fixedHelper =
      'import fs from "node:fs";\nfs.mkdirSync("out", { recursive: true });\nfs.writeFileSync("out/result.json", "[]\\n");\n';
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let requestCount = 0;
    let helperWriteCalls = 0;
    let helperRunCalls = 0;

    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;

      if (requestCount === 1 || requestCount === 3 || requestCount === 4) {
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
        if (requestCount === 3) {
          const messages = JSON.stringify(body.messages);
          expect(messages).toContain('This was a timeout');
          expect(messages).toContain('RegExp.exec');
        }
        if (requestCount === 4) {
          const messages = JSON.stringify(body.messages);
          expect(messages).toContain('byte-for-byte identical');
          expect(messages).toContain('will not be run again');
        }
        const content = requestCount === 4 ? fixedHelper : failedHelper;
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_write_${requestCount}`,
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'scripts/clean_data.mjs',
                          content,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }

      expect(requestCount === 2 || requestCount === 5).toBe(true);
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['run_nodejs_script']);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_run_${requestCount}`,
                    type: 'function',
                    function: {
                      name: 'run_nodejs_script',
                      arguments: '{"path":"scripts/clean_data.mjs"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) => name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'write_file') {
          helperWriteCalls += 1;
          return `Wrote ${String(args.path)}`;
        }
        if (name === 'run_nodejs_script') {
          helperRunCalls += 1;
          return helperRunCalls === 1
            ? '✗ scripts/clean_data.mjs timed out\nerror: Script exceeded 30000ms timeout and was killed.'
            : '✓ scripts/clean_data.mjs completed (exit 0)';
        }
        return `ERROR: unexpected ${name}`;
      },
    };

    await expect(
      session.sendAndWait(
        'Normalize data/raw/input.csv into out/result.json. Have a Node script read data/raw/input.csv with fs.readFileSync and write out/result.json with fs.writeFileSync. Do not hand-type the rows.',
      ),
    ).resolves.toBe('');

    expect(helperWriteCalls).toBe(2);
    expect(helperRunCalls).toBe(2);
    expect(bodies).toHaveLength(5);
  });

  it('retries an atomically rejected helper with write_file instead of reading or patching it', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{
        function: {
          name: string;
          parameters?: { properties?: { path?: { enum?: string[] } } };
        };
      }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let helperWriteAttempts = 0;
    let ranScript = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"records/raw-notes.txt","raw":true}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_bad_helper',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments:
                          '{"path":"scripts/clean_data.mjs","content":"import fs from \\"node:fs\\";\\nconst broken = ;\\n"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 3) {
        expect(JSON.stringify(body.messages)).toContain('THE FILE WAS NOT WRITTEN');
        expect(JSON.stringify(body.messages)).toContain('[Local-model rejected-write recovery:');
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
        expect(body.tool_choice).toBe('required');
        expect(body.tools?.[0]?.function.parameters?.properties?.path?.enum).toEqual([
          'scripts/clean_data.mjs',
        ]);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_fixed_helper',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments:
                          '{"path":"scripts/clean_data.mjs","content":"import fs from \\"node:fs\\";\\nfs.writeFileSync(\\"records/attendees.csv\\", \\"id,email\\\\n\\");\\n"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['run_nodejs_script']);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_run',
                    type: 'function',
                    function: {
                      name: 'run_nodejs_script',
                      arguments: '{"path":"scripts/clean_data.mjs"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    const names = new Set([
      'read_file',
      'write_file',
      'replace_in_file',
      'replace_lines',
      'append_to_file',
      'run_nodejs_script',
    ]);
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () =>
        [...names].map((name) => ({
          name,
          description: `${name} tool`,
          parameters: { type: 'object' },
        })),
      hasTool: (name: string) => names.has(name),
      callTool: async (name: string) => {
        if (name === 'read_file') return 'id,email\nA-1,Alice@example.com';
        if (name === 'write_file') {
          helperWriteAttempts += 1;
          if (helperWriteAttempts === 1) {
            return 'ERROR: scripts/clean_data.mjs: syntax error at line 2, col 16: Expression expected. This write is rejected atomically; no bytes from this call were persisted. THE FILE WAS NOT WRITTEN by this call.';
          }
          return 'Wrote scripts/clean_data.mjs';
        }
        if (name === 'run_nodejs_script') {
          ranScript = true;
          return 'scripts/clean_data.mjs completed (exit 0)';
        }
        return `ERROR: unexpected ${name}`;
      },
    };

    await expect(
      session.sendAndWait(
        'Read `records/raw-notes.txt`, then normalize the records and produce the output file `records/attendees.csv`. Write a Node script and run it.',
      ),
    ).resolves.toBe('');

    expect(helperWriteAttempts).toBe(2);
    expect(ranScript).toBe(true);
    expect(bodies).toHaveLength(4);
  });

  it('aborts reasoning-only direct file-work retries into the corrective path', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let requestCount = 0;
    let streamAborted = false;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"notes/source.txt","raw":true}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
        return abortableSseResponse(
          init?.signal as AbortSignal | undefined,
          Array.from({ length: 220 }, () => ({
            choices: [
              {
                index: 0,
                delta: { reasoning_content: 'thinking '.repeat(20) },
              },
            ],
          })),
          () => {
            streamAborted = true;
          },
        );
      }
      expect(JSON.stringify(body.messages)).toContain('no output file was written');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out/summary.md","content":"# Summary\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'read_file') return 'source note';
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote out/summary.md';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        'Please read notes/source.txt and produce the output file out/summary.md as markdown.',
      ),
    ).resolves.toBe('');

    expect(streamAborted).toBe(true);
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it('does not count short reasoning bursts toward the constrained no-signal chunk limit', async () => {
    // Regression: gemma4-e4b (channel profile, thinking kept ON in the
    // grammar-fallback repair path) streams reasoning in many tiny chunks.
    // The no-signal chunk counter treated each as a bare framing chunk and
    // aborted at 32 chunks (~130 reasoning chars) — before the model could
    // emit its tool call, deterministically failing every constrained edit
    // turn (core sweep: schema-migration + symptom-debug).
    // Reasoning is bounded by CONSTRAINED_TOOL_REASONING_CHAR_LIMIT, not
    // the framing-chunk limit; 40 short chunks under that budget must
    // reach the tool call.
    const bodies: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    let requestCount = 0;
    let streamAborted = false;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"notes/source.txt","raw":true}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      return abortableSseResponse(
        init?.signal as AbortSignal | undefined,
        [
          // 40 short reasoning chunks (160 chars total — well under the
          // 1024 reasoning budget, but past the 32-chunk framing limit).
          ...Array.from({ length: 40 }, () => ({
            choices: [{ index: 0, delta: { reasoning_content: 'hm. ' } }],
          })),
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: '{"path":"out/summary.md","content":"# Summary\\n"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ],
        () => {
          streamAborted = true;
        },
      );
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'read_file') return 'source note';
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote out/summary.md';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        'Please read notes/source.txt and produce the output file out/summary.md as markdown.',
      ),
    ).resolves.toBe('');

    // The reasoning burst must NOT trip the no-signal abort: no stream
    // abort, no corrective third request, and the write landed.
    expect(streamAborted).toBe(false);
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(2);
  });

  it('aborts silent direct file-work retries into the corrective path', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let streamAborted = false;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
        tool_choice?: unknown;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"notes/source.txt","raw":true}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
        return reasoningThenSilentUntilAbortSseResponse(
          init?.signal as AbortSignal | undefined,
          () => {
            streamAborted = true;
          },
        );
      }
      expect(JSON.stringify(body.messages)).toContain('no output file was written');
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(body.tool_choice).toBe('required');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out/summary.md","content":"# Summary\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      constrainedToolNoSignalMs: 20,
    });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'read_file') return 'source note';
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote out/summary.md';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        'Please read notes/source.txt and produce the output file out/summary.md as markdown.',
      ),
    ).resolves.toBe('');

    expect(streamAborted).toBe(true);
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it('uses the pre-first-byte watchdog, not the constrained-action timer, during direct file-work prefill', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let fetchAborted = false;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
        tool_choice?: unknown;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"notes/source.txt","raw":true}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener(
            'abort',
            () => {
              fetchAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      }
      expect(JSON.stringify(body.messages)).toContain('no output file was written');
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(body.tool_choice).toBe('required');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out/summary.md","content":"# Summary\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      constrainedToolNoSignalMs: 20,
      preFirstByteIdleMs: 60,
    });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'read_file') return 'source note';
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote out/summary.md';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        'Please read notes/source.txt and produce the output file out/summary.md as markdown.',
      ),
    ).rejects.toThrow(/no generated tokens/i);

    expect(fetchAborted).toBe(true);
    expect(wroteFile).toBe(false);
    expect(bodies).toHaveLength(2);
  });

  it('aborts silent immediate write_file turns into a corrective retry', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let streamAborted = false;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
        tool_choice?: unknown;
      };
      bodies.push(body);
      requestCount += 1;
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(body.tool_choice).toBe('required');
      if (requestCount === 1) {
        return reasoningThenSilentUntilAbortSseResponse(
          init?.signal as AbortSignal | undefined,
          () => {
            streamAborted = true;
          },
        );
      }
      expect(JSON.stringify(body.messages)).toContain('produced no `write_file` tool call');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out/customers.json","content":"[]\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      constrainedToolNoSignalMs: 20,
    });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote out/customers.json';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        '[Deliverable expected as a FILE at `out/customers.json`. Your first assistant action should be the tool call `write_file({ path, content })`; draft inside the tool argument, not in chat.]',
      ),
    ).resolves.toContain('out/customers.json');

    expect(streamAborted).toBe(true);
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(2);
  });

  it('uses the pre-first-byte watchdog, not the constrained-action timer, during immediate-write prefill', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let fetchAborted = false;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
        tool_choice?: unknown;
      };
      bodies.push(body);
      requestCount += 1;
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(body.tool_choice).toBe('required');
      if (requestCount === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener(
            'abort',
            () => {
              fetchAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      }
      expect(JSON.stringify(body.messages)).toContain('produced no `write_file` tool call');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out/customers.json","content":"[]\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      constrainedToolNoSignalMs: 20,
      preFirstByteIdleMs: 60,
    });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote out/customers.json';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        '[Deliverable expected as a FILE at `out/customers.json`. Your first assistant action should be the tool call `write_file({ path, content })`; draft inside the tool argument, not in chat.]',
      ),
    ).rejects.toThrow(/no generated tokens/i);

    expect(fetchAborted).toBe(true);
    expect(wroteFile).toBe(false);
    expect(bodies).toHaveLength(1);
  });

  it('clamps urgent missing-file turns to write_file even when the session bridge is wider', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let fetchAborted = false;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
        tool_choice?: unknown;
      };
      bodies.push(body);
      requestCount += 1;
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(body.tool_choice).toBe('required');
      if (requestCount === 1) {
        return await new Promise<Response>((resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          const timer = setTimeout(
            () =>
              resolve(
                sseResponse([
                  {
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: 'call_write_after_prefill',
                              type: 'function',
                              function: {
                                name: 'write_file',
                                arguments: '{"path":"out/customers.json","content":"[]\\n"}',
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
                  '[DONE]',
                ]),
              ),
            50,
          );
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              fetchAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      }
      expect(JSON.stringify(body.messages)).toContain('produced no `write_file` tool call');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out/customers.json","content":"[]\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      constrainedToolNoSignalMs: 20,
      preFirstByteIdleMs: 200,
    });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote out/customers.json';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        '[scenario check] There is still **no `out/customers.json`** in the workspace. Stop reading/planning and write the file now: `write_file({ path: "out/customers.json", content: <the full deliverable contents> })`. Do not end your turn until `write_file` has landed the file.',
      ),
    ).resolves.toContain('out/customers.json');

    expect(fetchAborted).toBe(false);
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it('clamps poisoned deliverable recovery turns to write_file even when the bridge is wider', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: unknown;
    }> = [];
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
        tool_choice?: unknown;
      };
      bodies.push(body);
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(body.tool_choice).toBe('required');
      expect(JSON.stringify(body.messages)).toContain('[eval recovery]');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out/customers.json","content":"[]\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        {
          name: 'run_nodejs_script',
          description: 'Run a Node.js script.',
          parameters: { type: 'object' },
        },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'write_file' || name === 'run_nodejs_script',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote out/customers.json';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        [
          '[eval recovery]',
          'Your previous turn aborted, so the scheduler stopped automatic follow-up for this project.',
          'Abort reason: [llama-cpp] direct file-work turn ended without a successful workspace mutation after 2 corrective nudge(s).',
          'Latest scenario check: score 0, bytes 0.',
          'Your next tool call should write or repair the requested workspace deliverable. Prefer `write_file` for recovery after a failed line-based edit.',
          'Do not answer only in prose. Do not retry the same malformed `replace_lines` or `replace_in_file` call. Make one concrete workspace edit, then stop with a short status note.',
        ].join('\n'),
      ),
    ).resolves.toContain('out/customers.json');

    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it('rejects wrong-path write_file calls during target-known immediate writes', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string; parameters?: Record<string, unknown> } }>;
      tool_choice?: unknown;
    }> = [];
    let requestCount = 0;
    let wroteWrongPath = false;
    let wroteTarget = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string; parameters?: Record<string, unknown> } }>;
        tool_choice?: unknown;
      };
      bodies.push(body);
      requestCount += 1;
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(body.tool_choice).toBe('required');
      const writeParams = body.tools?.[0]?.function.parameters as
        | { properties?: { path?: { enum?: string[] } } }
        | undefined;
      expect(writeParams?.properties?.path?.enum).toEqual(['out/customers.json']);
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_wrong',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: '{"path":"process.mjs","content":"console.log(1)\\n"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(JSON.stringify(body.messages)).toContain('must write exactly `out/customers.json`');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_right',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"out/customers.json","content":"[]\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'write_file',
      callTool: async (_name: string, args: Record<string, unknown>) => {
        if (args.path === 'process.mjs') wroteWrongPath = true;
        if (args.path === 'out/customers.json') {
          wroteTarget = true;
          return 'Wrote out/customers.json';
        }
        return 'Wrote unexpected';
      },
    };

    await expect(
      session.sendAndWait(
        '[scenario check] There is still **no `out/customers.json`** in the workspace. Stop reading/planning and write the file now: `write_file({ path: "out/customers.json", content: <the full deliverable contents> })`. Do not end your turn until `write_file` has landed the file.',
      ),
    ).resolves.toContain('out/customers.json');

    expect(wroteWrongPath).toBe(false);
    expect(wroteTarget).toBe(true);
    expect(bodies).toHaveLength(2);
  });

  it('keeps write_file available when a scenario repair carries a mandatory first-write directive', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(
        (
          body.tools?.[0]?.function as unknown as {
            parameters?: { properties?: { path?: { enum?: string[] } } };
          }
        ).parameters?.properties?.path?.enum,
      ).toEqual(['src/controller.ts']);
      expect(JSON.stringify(body.messages)).toContain('[Local-model source rewrite mode:');
      expect(JSON.stringify(body.messages)).not.toContain('[Local-model source patch mode:');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"src/controller.ts","content":"export const value = 2;\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'validate', description: 'Validate a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        { name: 'append_to_file', description: 'Append a file.', parameters: { type: 'object' } },
        { name: 'message_gezel', description: 'Delegate.', parameters: { type: 'object' } },
      ],
      hasTool: () => true,
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'write_file' && args.path === 'src/controller.ts') {
          wroteFile = true;
          return 'Wrote src/controller.ts';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        '[Deliverable expected as a FILE at `src/controller.ts`. Your first assistant action should be the tool call `write_file({ path, content })`; draft inside the tool argument.]\n' +
          "[scenario check] I looked at `src/controller.ts` and the success criteria aren't met yet. Signals that didn't fire: **all-call-sites-updated**. " +
          'If this is a small edit, use `replace_in_file`; otherwise use `write_file` to re-emit the checked file. ' +
          'Your next assistant action should be a file-writing tool call for `src/controller.ts`.',
      ),
    ).resolves.toBe('');

    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it('adds a source patch-mode nudge after a scenario source repair read', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let requestCount = 0;
    let patched = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        expect(body.tools?.map((entry) => entry.function.name).sort()).toEqual([
          'read_file',
          'replace_in_file',
          'replace_lines',
          'validate',
        ]);
        expect(JSON.stringify(body.messages)).toContain('Signals that did not fire');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"index.html"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(body.tools?.map((entry) => entry.function.name).sort()).toEqual([
        'replace_in_file',
        'replace_lines',
      ]);
      expect(JSON.stringify(body.messages)).toContain('[Local-model source patch mode:');
      expect(JSON.stringify(body.messages)).toContain(
        'For a duplicate identifier, remove one duplicate declaration',
      );
      expect(JSON.stringify(body.messages)).toContain('Do not edit signals listed as fired');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_lines',
                    type: 'function',
                    function: {
                      name: 'replace_lines',
                      arguments:
                        '{"path":"index.html","startLine":46,"endLine":46,"content":"<input id=\\"dueDateInput\\" type=\\"date\\">"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'validate', description: 'Validate a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' ||
        name === 'validate' ||
        name === 'replace_in_file' ||
        name === 'replace_lines' ||
        name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'read_file') {
          return '1→ <form>\\n46→ <button>Add</button>';
        }
        if (name === 'replace_lines') {
          patched = true;
          return 'replaced lines';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `index.html` and the success criteria aren't met yet. Signals that fired: priority-values, priority-input, priority-filter. Signals that didn't fire: **due-date-input**, **due-summary**, **date-logic**. Patch the deliverable.",
      ),
    ).resolves.toBe('');

    expect(patched).toBe(true);
    expect(bodies).toHaveLength(2);
  });

  it('keeps read_file available for one dependency refresh on cross-file compiler repairs', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let requestCount = 0;
    let patched = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;
      const names = body.tools?.map((entry) => entry.function.name).sort() ?? [];
      if (requestCount === 1) {
        expect(names).toContain('read_file');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_target',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"src/migrate.ts"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        expect(names).toContain('read_file');
        expect(JSON.stringify(body.messages)).toContain('[Local-model dependency refresh:');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_dependency',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"src/types.ts"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(names).toEqual(['replace_in_file', 'replace_lines']);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_patch',
                    type: 'function',
                    function: {
                      name: 'replace_in_file',
                      arguments:
                        '{"path":"src/migrate.ts","find":"oldRecord.name","replace":"oldRecord.firstName"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'validate', description: 'Validate a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: () => true,
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'read_file') {
          return args.path === 'src/types.ts'
            ? 'export type User = { id: number; firstName: string; lastName: string }'
            : 'export function migrateUser(oldRecord: LegacyUser): User { return oldRecord.name }';
        }
        if (name === 'replace_in_file') {
          patched = true;
          return 'replaced content';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `src/migrate.ts` and the success criteria aren't met yet. Signals that didn't fire: **tsc-clean**. Specific failure: Property 'name' does not exist on type 'User'. Patch the source file.",
      ),
    ).resolves.toBe('');

    expect(patched).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it('switches a missing surgical-edit target to a path-pinned write_file create', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{
        function: {
          name: string;
          parameters?: { properties?: { path?: { enum?: string[] } } };
        };
      }>;
    }> = [];
    let requestCount = 0;
    let created = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;
      const names = body.tools?.map((entry) => entry.function.name).sort() ?? [];
      if (requestCount === 1) {
        expect(names).toEqual(['read_file', 'replace_in_file', 'replace_lines', 'validate']);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_missing_patch',
                      type: 'function',
                      function: {
                        name: 'replace_lines',
                        arguments:
                          '{"path":"tests/migrate.test.ts","startLine":1,"endLine":1,"content":"test(\'migration\', () => {});"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }

      expect(names).toEqual(['write_file']);
      expect(body.tools?.[0]?.function.parameters?.properties?.path?.enum).toEqual([
        'tests/migrate.test.ts',
      ]);
      expect(JSON.stringify(body.messages)).toContain('[Local-model missing-file recovery:');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_create',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"tests/migrate.test.ts","content":"test(\'migration\', () => {});\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    const toolNames = ['read_file', 'validate', 'replace_in_file', 'replace_lines', 'write_file'];
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () =>
        toolNames.map((name) => ({
          name,
          description: `${name} tool`,
          parameters: { type: 'object' },
        })),
      hasTool: (name: string) => toolNames.includes(name),
      callTool: async (name: string) => {
        if (name === 'replace_lines') {
          return 'ERROR: Cannot edit tests/migrate.test.ts: file does not exist (ENOENT). Use `write_file` to create it first.';
        }
        if (name === 'write_file') {
          created = true;
          return 'Wrote tests/migrate.test.ts';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `tests/migrate.test.ts` and the success criteria aren't met yet. Signals that didn't fire: **test-clean**. Specific failure: migration coverage is missing. Patch the source file.",
      ),
    ).resolves.toBe('');

    expect(created).toBe(true);
    expect(bodies).toHaveLength(2);
  });

  it('escalates an ordinary localized repair to a path-pinned rewrite after two failed patches', async () => {
    const bodies: Array<{
      tools?: Array<{
        function: {
          name: string;
          parameters?: { properties?: { path?: { enum?: string[] } } };
        };
      }>;
      messages: Array<{ role: string; content: string | null }>;
    }> = [];
    let requestCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number];
      bodies.push(body);
      requestCount += 1;
      const names = body.tools?.map((entry) => entry.function.name).sort() ?? [];
      if (requestCount === 1) {
        expect(names).toEqual(['read_file', 'replace_in_file', 'replace_lines', 'write_file']);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"src/counter.ts"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount <= 3) {
        expect(names).toEqual(['replace_in_file', 'replace_lines']);
        const toolName = requestCount === 2 ? 'replace_in_file' : 'replace_lines';
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_patch_${requestCount}`,
                      type: 'function',
                      function: {
                        name: toolName,
                        arguments:
                          toolName === 'replace_in_file'
                            ? '{"path":"src/counter.ts","find":"missing","replace":"return value + 1;"}'
                            : '{"path":"src/counter.ts","startLine":99,"endLine":99,"content":"return value + 1;"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(names).toEqual(['write_file']);
      expect(body.tools?.[0]?.function.parameters?.properties?.path?.enum).toEqual([
        'src/counter.ts',
      ]);
      expect(JSON.stringify(body.messages)).toContain('[Local-model source rewrite fallback:');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_rewrite',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"src/counter.ts","content":"export function next(value: number) { return value + 1; }\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    const names = new Set(['read_file', 'replace_in_file', 'replace_lines', 'write_file']);
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () =>
        [...names].map((name) => ({
          name,
          description: `${name} tool`,
          parameters: { type: 'object' },
        })),
      hasTool: (name: string) => names.has(name),
      callTool: async (name: string) => {
        if (name === 'read_file') return '1→ export function next(value: number) { return value; }';
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote src/counter.ts';
        }
        return `ERROR: ${name} did not match the current source`;
      },
    };

    await expect(
      session.sendAndWait(
        'Please fix the small bug in `src/counter.ts` in place and preserve its exported API.',
      ),
    ).resolves.toBe('');

    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(4);
  });

  it('keeps source scenario repair off the whole-file rewrite surface after a failed patch', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let requestCount = 0;
    let patched = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      const toolNames = body.tools?.map((entry) => entry.function.name).sort();
      expect(toolNames).toEqual(['read_file', 'replace_in_file', 'replace_lines', 'validate']);
      expect(toolNames).not.toContain('write_file');
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_patch_fail',
                      type: 'function',
                      function: {
                        name: 'replace_in_file',
                        arguments:
                          '{"path":"index.html","find":"<button>Add</button>","replace":"<input id=\\"dueDateInput\\" type=\\"date\\"><button>Add</button>"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(JSON.stringify(body.messages)).toContain('Do not rewrite the whole source file');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_lines',
                    type: 'function',
                    function: {
                      name: 'replace_lines',
                      arguments:
                        '{"path":"index.html","startLine":46,"endLine":46,"content":"<input id=\\"dueDateInput\\" type=\\"date\\">\\n<button>Add</button>"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'validate', description: 'Validate a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' ||
        name === 'validate' ||
        name === 'replace_in_file' ||
        name === 'replace_lines' ||
        name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'replace_in_file') {
          return 'ERROR: pattern not found in index.html';
        }
        if (name === 'replace_lines') {
          patched = true;
          return 'replaced lines';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `index.html` and the success criteria aren't met yet. Signals that didn't fire: **due-date-input**, **due-summary**, **date-logic**. Patch the deliverable.",
      ),
    ).resolves.toBe('');

    expect(patched).toBe(true);
    expect(bodies).toHaveLength(2);
  });

  it('falls back to write_file only after repeated source patch failures', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let requestCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
        tools?: Array<{ function: { name: string } }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount <= 2) {
        expect(body.tools?.map((entry) => entry.function.name).sort()).toEqual([
          'read_file',
          'replace_in_file',
          'replace_lines',
          'validate',
        ]);
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_patch_fail_${requestCount}`,
                      type: 'function',
                      function: {
                        name: 'replace_in_file',
                        arguments:
                          '{"path":"src/controller.ts","find":"oldValue","replace":"newValue"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 3) {
        expect(body.tools?.map((entry) => entry.function.name)).toEqual(['read_file']);
        expect(
          (
            body.tools?.[0]?.function as {
              parameters?: { properties?: { path?: { enum?: string[] } } };
            }
          ).parameters?.properties?.path?.enum,
        ).toEqual(['src/controller.ts']);
        expect(JSON.stringify(body.messages)).toContain('[Local-model source rewrite refresh:');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_before_rewrite',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"src/controller.ts","raw":true}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(body.tools?.map((entry) => entry.function.name)).toEqual(['write_file']);
      expect(JSON.stringify(body.messages)).toContain('[Local-model source rewrite fallback:');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write_fallback',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"src/controller.ts","content":"export const newValue = 2;\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'validate', description: 'Validate a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'replace_lines', description: 'Patch lines.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
        { name: 'message_gezel', description: 'Delegate.', parameters: { type: 'object' } },
      ],
      hasTool: () => true,
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'replace_in_file') return 'ERROR: pattern not found in src/controller.ts';
        if (name === 'read_file') return 'export const oldValue = 1;\n';
        if (name === 'write_file') {
          wroteFile = true;
          return 'Wrote src/controller.ts';
        }
        return 'ERROR: unexpected tool';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `src/controller.ts` and the success criteria aren't met yet. Signals that didn't fire: **all-call-sites-updated**. Patch the deliverable with the smallest correct source edit.",
      ),
    ).resolves.toBe('');

    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(4);
  });

  it('ends a scenario repair turn immediately after the first successful mutation', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      bodies.push(body);
      if (bodies.length > 1) {
        throw new Error('scenario repair should stop after the first successful mutation');
      }
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"src/state.js","content":"export const tasks = [];"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ index: 0, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_file' || name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'write_file') {
          wroteFile = true;
          return 'wrote file';
        }
        return 'file contents';
      },
    };

    await expect(
      session.sendAndWait(
        '[runtime check] I opened `index.html` in a headless browser. 1 assertion(s) failed: seed-tasks-render. Patch the relevant source file with `write_file`.',
      ),
    ).resolves.toBe('');
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it('adds a DOM-selector hint for browser null-property runtime repairs', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      bodies.push(body);
      expect(body.messages.at(-1)?.content).toContain('[DOM null repair:');
      expect(body.messages.at(-1)?.content).toContain('compare `getElementById(...)`');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"src/app.js","content":"const title = document.getElementById(\\"title\\");"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'write_file',
      callTool: async () => {
        wroteFile = true;
        return 'wrote file';
      },
    };

    await expect(
      session.sendAndWait(
        "[runtime check] I opened `index.html` in a headless browser. 1 assertion(s) failed: no-page-errors. Browser console reported: Cannot read properties of null (reading 'value'). Patch the relevant source file.",
      ),
    ).resolves.toBe('');
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it('steers failed non-source scenario repair mutations toward a complete write', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let requestCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_replace',
                      type: 'function',
                      function: {
                        name: 'replace_in_file',
                        arguments:
                          '{"path":"launch-notes.md","find":"## Tasks","replace":"## Tasks\\n- Seed tasks render"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      expect(body.messages.at(-1)?.role).toBe('tool');
      expect(body.messages.at(-1)?.content).toContain(
        'This repair edit did not change the workspace',
      );
      expect(body.messages.at(-1)?.content).toContain('write_file');
      expect(body.messages.at(-1)?.content).toContain('complete corrected source file');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"launch-notes.md","content":"# Launch Notes\\n\\n## Tasks\\n- Seed tasks render"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'replace_in_file' || name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'replace_in_file') return 'ERROR: find text not found in launch-notes.md';
        if (name === 'write_file') {
          wroteFile = true;
          return 'wrote file';
        }
        return '# Launch Notes';
      },
    };

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `launch-notes.md` and the success criteria aren't met yet. Specific failure: task-summary: summarize the seeded launch tasks. Patch the deliverable.",
      ),
    ).resolves.toBe('');
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(2);
  });

  it('forces full-file writes after a failed repair edit and fresh read still produce prose', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let requestCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_replace',
                      type: 'function',
                      function: {
                        name: 'replace_in_file',
                        arguments:
                          '{"path":"src/app.js","find":"const toIsoDate =","replace":"function toIsoDate"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 2) {
        expect(body.messages.at(-1)?.role).toBe('tool');
        expect(body.messages.at(-1)?.content).toContain(
          'This repair edit did not change the workspace',
        );
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"src/app.js"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (requestCount === 3) {
        expect(body.messages.at(-1)?.role).toBe('tool');
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  content:
                    'I found the duplicate helper and need to remove the second declaration.',
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'stop' }] },
          '[DONE]',
        ]);
      }
      expect(body.messages.at(-1)?.role).toBe('user');
      expect(body.messages.at(-1)?.content).toContain('Do not read again');
      expect(body.messages.at(-1)?.content).toContain('START with `write_file`');
      expect(body.messages.at(-1)?.content).toContain('complete corrected file contents');
      expect(body.messages.at(-1)?.content).not.toContain('one more targeted read');
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments:
                        '{"path":"src/app.js","content":"import { toIsoDate } from \\"./state.js\\";\\nrenderBoard();"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'replace_in_file', description: 'Patch a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) =>
        name === 'read_file' || name === 'replace_in_file' || name === 'write_file',
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'replace_in_file') return 'ERROR: find text not found in src/app.js';
        if (name === 'write_file') {
          wroteFile = true;
          return 'wrote file';
        }
        return 'import { toIsoDate } from "./state.js";\nconst toIsoDate = () => "";';
      },
    };

    await expect(
      session.sendAndWait(
        '[runtime check] I opened `index.html` in a headless browser. 1 assertion(s) failed: no-page-errors. Identifier `toIsoDate` has already been declared. Patch the relevant source file.',
      ),
    ).resolves.toBe('');
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(4);
  });

  it('keeps scenario repair ramble aborts in-loop as mutation nudges', async () => {
    const encoder = new TextEncoder();
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let requestCount = 0;
    let wroteFile = false;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      bodies.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          start(streamCtrl) {
            const chunk = {
              choices: [
                {
                  index: 0,
                  delta: {
                    content: `I have fixed the file and verified it locally. ${'planning '.repeat(300)}`,
                  },
                },
              ],
            };
            streamCtrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            const onAbort = () => streamCtrl.error(new DOMException('aborted', 'AbortError'));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (requestCount === 2) {
        expect(body.messages.at(-1)?.role).toBe('user');
        expect(body.messages.at(-1)?.content).toContain(
          'repair turn ended without changing any workspace file',
        );
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: '{"path":"index.html","content":"<!doctype html>"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'patched index.html' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'write_file',
      callTool: async (_name: string, _args: Record<string, unknown>) => {
        wroteFile = true;
        return 'wrote file';
      },
    };

    await expect(
      session.sendAndWait(
        '[scenario check] I looked at `index.html` and the success criteria aren\'t met yet. Signals that didn\'t fire: **due-date-input**. Use `write_file({ path: "index.html", content: ... })` with the corrected file.',
      ),
    ).resolves.toBe('');
    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(2);
  });

  it('promotes completed revised-HTML prose with a fenced block to write_file', async () => {
    let requestCount = 0;
    // Initialized to `{}` (not `null`) so TS doesn't narrow it to `null`
    // at the read sites below — the only assignment is inside the
    // `callTool` closure, which synchronous control-flow analysis can't
    // see, and `null?.path` would collapse to `never`.
    let written: Record<string, unknown> = {};
    globalThis.fetch = (async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  content:
                    "Here's the updated `index.html` file:\n\n```html\n<!DOCTYPE html>\n<html><body><h1>Tic-Tac-Toe</h1><script>document.body.onclick=()=>{};</script></body></html>\n```",
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'stop' }] },
          '[DONE]',
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'saved' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'mistral-7b-q4' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'write_file',
      callTool: async (_name: string, args: Record<string, unknown>) => {
        written = args;
        return 'wrote file';
      },
    };

    await expect(session.sendAndWait('build it')).resolves.toContain('saved');
    expect(written.path).toBe('index.html');
    expect(String(written.content)).toContain('<h1>Tic-Tac-Toe</h1>');
  });

  it('converts caller-signal abort into a cancellation message', async () => {
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      // Resolve only via abort — the test aborts below.
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (sig?.aborted) {
          onAbort();
        } else {
          sig?.addEventListener('abort', onAbort, { once: true });
        }
      });
    }) as typeof fetch;

    const ctrl = new AbortController();
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const promise = session.sendAndWait('hi', {
      queue: { lane: 'interactive', signal: ctrl.signal },
    });
    // Give the fetch stub a tick to attach its abort listener.
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await expect(promise).rejects.toThrow(turnCancelledMessage());
  });
});

describe('reasoning_content replay (ds4 live-KV alignment)', () => {
  /** Fake bridge with one read_file tool; mirrors the direct-edit test's injection. */
  function injectReadFileBridge(session: unknown): void {
    const internal = session as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_file',
      callTool: async () => 'contents of notes.txt',
    };
  }

  /**
   * Two-request tool turn: reasoning + read_file call, then reasoning +
   * final prose. The SSE `reasoning_content` deltas must be echoed
   * verbatim on the committed assistant messages so ds4-server's
   * re-render (`<think>{reasoning_content}</think>` + remembered DSML)
   * reproduces the generated tokens and its live-KV prefix match
   * survives the continuation. Without the echo every iteration logs
   * `live kv cache miss … reason=token-mismatch` and re-prefills the
   * whole conversation tail.
   */
  function scriptedToolTurnFetch(bodies: Array<Record<string, unknown>>): typeof fetch {
    return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (bodies.length === 1) {
        return sseResponse([
          { choices: [{ index: 0, delta: { reasoning_content: 'Need to ' } }] },
          { choices: [{ index: 0, delta: { reasoning_content: 'read the file.' } }] },
          { choices: [{ index: 0, delta: { content: 'I should inspect it now.' } }] },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_1',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"notes.txt"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { reasoning_content: 'Looks fine.' } }] },
        { choices: [{ index: 0, delta: { content: 'All good.' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
  }

  it('echoes per-iteration reasoning verbatim on committed assistant turns when enabled', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = scriptedToolTurnFetch(bodies);
    const preambleFolding = lookupBehavior('turn.preamble-folding');
    if (!preambleFolding) throw new Error('turn.preamble-folding behavior is not registered');

    const provider = new LlamaCppProvider({
      baseUrl: 'http://ds4.test',
      replayReasoningContent: true,
    });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'deepseek-v4',
      profile: {
        catalogId: 'deepseek-v4',
        tier: 'large',
        style: { family: 'deepseek', reasoningFormat: 'think', toolCallFormat: 'function-call' },
        behaviors: [{ id: 'turn.preamble-folding', config: undefined, behavior: preambleFolding }],
      },
    });
    injectReadFileBridge(session);

    const reply = await session.sendAndWait('What is in notes.txt?');
    expect(reply).toBe('All good.');
    expect(bodies).toHaveLength(2);

    // The continuation request replays the tool-call assistant turn with
    // its reasoning bytes intact (concatenated SSE deltas, no reflow).
    const continuation = bodies[1]?.messages as Array<Record<string, unknown>>;
    const toolTurn = continuation.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(toolTurn?.reasoning_content).toBe('Need to read the file.');
    expect(toolTurn?.content).toBe('I should inspect it now.');
    expect((toolTurn?.tool_calls as Array<{ id: string }>)[0]?.id).toBe('call_read_1');

    // The final assistant commit carries its own iteration's reasoning,
    // replayed on the NEXT user turn's request.
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'ok' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    await session.sendAndWait('thanks');
    const followUp = bodies[2]?.messages as Array<Record<string, unknown>>;
    const finalTurn = followUp.find((m) => m.role === 'assistant' && m.content === 'All good.');
    expect(finalTurn?.reasoning_content).toBe('Looks fine.');

    // Separate-channel reasoning also feeds the captured UI trace.
    expect(
      (session as unknown as { getLastTurnReasoning: () => string | undefined })
        .getLastTurnReasoning,
    ).toBeDefined();
  });

  it('aggregates separate-channel reasoning into the captured turn trace', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = scriptedToolTurnFetch(bodies);

    const provider = new LlamaCppProvider({
      baseUrl: 'http://ds4.test',
      replayReasoningContent: true,
    });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'deepseek-v4' });
    injectReadFileBridge(session);

    await session.sendAndWait('What is in notes.txt?');
    const reasoning = (
      session as unknown as { getLastTurnReasoning: () => string | undefined }
    ).getLastTurnReasoning();
    expect(reasoning).toBe('Need to read the file.\n\nLooks fine.');
  });

  it('does not attach reasoning_content when the flag is off (llama-server default)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = scriptedToolTurnFetch(bodies);

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'qwen' });
    injectReadFileBridge(session);

    await session.sendAndWait('What is in notes.txt?');
    expect(bodies).toHaveLength(2);
    // Request bodies are model INPUT — reasoning_content must not leak
    // into them for engines whose templates would render it differently.
    expect(JSON.stringify(bodies[1]?.messages)).not.toContain('reasoning_content');
  });
});

describe('LlamaCppProvider supervisor integration', () => {
  const cudaExit = {
    incidentId: 'native-55121-1234',
    pid: 55121,
    startedAt: 1000,
    exitedAt: 1234,
    uptimeMs: 234,
    code: null,
    signal: 'SIGABRT' as const,
    expected: false,
    panicKind: 'cuda-invalid-argument' as const,
    panicLine: '[llama-server] CUDA error: invalid argument',
    outputTail: '[llama-server] CUDA error: invalid argument\n',
    diagnostics: { cudaArchitectures: '121a-real', computeCapability: '12.1' },
  };

  it('attributes a CUDA crash that happens while the engine is starting', async () => {
    const supervisor = {
      async ensureRunning() {
        throw new Error('[llama-server] child exited before becoming ready');
      },
      lastExitSnapshot() {
        return { ...cudaExit, exitedAt: Date.now() };
      },
      markUsed() {},
      async stop() {},
    } as unknown as NativeEngineSupervisor;

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    await expect(session.sendAndWait('ping')).rejects.toMatchObject({
      code: 'native-engine-crash',
      incidentId: 'native-55121-1234',
      panicKind: 'cuda-invalid-argument',
    });
  });

  it('does not blame a new startup failure on a stale native exit', async () => {
    const supervisor = {
      async ensureRunning() {
        throw new Error('[llama-server] model file is missing');
      },
      lastExitSnapshot() {
        return cudaExit;
      },
      markUsed() {},
      async stop() {},
    } as unknown as NativeEngineSupervisor;

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const error = await session.sendAndWait('ping').catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NativeEngineCrashedError);
    expect((error as Error).message).toContain('model file is missing');
  });

  it('attributes a pre-response transport failure to the supervised CUDA crash', async () => {
    const supervisor = {
      async ensureRunning() {
        return { command: 'fake', args: [], baseUrl: 'http://127.0.0.1:18099' };
      },
      markUsed() {},
      async waitForUnexpectedExitSince() {
        return cudaExit;
      },
      async stop() {},
    } as unknown as NativeEngineSupervisor;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const error = await session.sendAndWait('ping').catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeEngineCrashedError);
    expect(error).toMatchObject({
      code: 'native-engine-crash',
      engine: 'llama-cpp',
      incidentId: 'native-55121-1234',
      panicKind: 'cuda-invalid-argument',
    });
    expect((error as Error).message).toContain('It will restart on the next request');
  });

  it('attributes an open SSE stream terminating to the supervised CUDA crash', async () => {
    const supervisor = {
      async ensureRunning() {
        return { command: 'fake', args: [], baseUrl: 'http://127.0.0.1:18099' };
      },
      markUsed() {},
      async waitForUnexpectedExitSince() {
        return cudaExit;
      },
      async stop() {},
    } as unknown as NativeEngineSupervisor;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    await expect(session.sendAndWait('ping')).rejects.toMatchObject({
      code: 'native-engine-crash',
      incidentId: 'native-55121-1234',
    });
  });

  it('calls supervisor.ensureRunning() and markUsed() on each turn', async () => {
    const ensureCalls: number[] = [];
    let usedCalls = 0;
    const supervisor = {
      async ensureRunning() {
        ensureCalls.push(Date.now());
        return {
          command: 'fake',
          args: [],
          baseUrl: 'http://127.0.0.1:18099',
        };
      },
      markUsed() {
        usedCalls++;
      },
      async stop() {},
    } as unknown as NativeEngineSupervisor;

    globalThis.fetch = stubFetch({
      '127.0.0.1:18099/v1/chat/completions': () =>
        sseResponse([{ choices: [{ index: 0, delta: { content: 'hi' } }] }, '[DONE]']),
    });

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const reply = await session.sendAndWait('ping');
    expect(reply).toBe('hi');
    expect(ensureCalls).toHaveLength(1);
    expect(usedCalls).toBeGreaterThanOrEqual(1);
  });

  it('keeps the llm GPU lease held until the streaming request finishes', async () => {
    let stopCalls = 0;
    const supervisor = {
      async ensureRunning() {
        return {
          command: 'fake',
          args: [],
          baseUrl: 'http://127.0.0.1:18099',
        };
      },
      markUsed() {},
      async stop() {
        stopCalls++;
      },
    } as unknown as NativeEngineSupervisor;
    const arbiter = new GpuArbiter({ policy: 'swap', log: () => {} });
    arbiter.registerEvictor('image', async () => {});

    const encoder = new TextEncoder();
    let streamCtrlResolve!: (ctrl: ReadableStreamDefaultController<Uint8Array>) => void;
    const streamCtrlReady = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => {
      streamCtrlResolve = resolve;
    });
    let fetchStartedResolve!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });
    globalThis.fetch = (async () => {
      fetchStartedResolve();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            streamCtrlResolve(ctrl);
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ supervisor, arbiter });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const sendPromise = session.sendAndWait('ping');
    await fetchStarted;

    let imageAcquired = false;
    const imagePending = arbiter.acquire('image').then(() => {
      imageAcquired = true;
    });
    await Promise.resolve();

    expect(imageAcquired).toBe(false);
    expect(stopCalls).toBe(0);

    const streamCtrl = await streamCtrlReady;
    streamCtrl.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`,
      ),
    );
    streamCtrl.enqueue(encoder.encode('data: [DONE]\n\n'));
    streamCtrl.close();

    await expect(sendPromise).resolves.toBe('hi');
    await imagePending;
    expect(imageAcquired).toBe(true);
    expect(stopCalls).toBe(1);
  });
});

describe('ToolCallAccumulator', () => {
  it('coalesces argument chunks by index', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '' },
    });
    acc.ingest({ index: 0, function: { arguments: '{"c' } });
    acc.ingest({ index: 0, function: { arguments: 'ity":"' } });
    acc.ingest({ index: 0, function: { arguments: 'Boston"}' } });

    const out = acc.finalize();
    expect(out).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Boston"}' },
      },
    ]);
  });

  it('keeps multiple tool calls ordered by their index', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest({ index: 1, id: 'c2', function: { name: 'b', arguments: '{}' } });
    acc.ingest({ index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } });
    const out = acc.finalize();
    expect(out.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('exposes raw accumulated arguments by tool name before finalize', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest({
      index: 0,
      id: 'call_write',
      function: { name: 'write_file', arguments: '{"path":"index.html",' },
    });
    acc.ingest({ index: 0, function: { arguments: '"content":"<html></html>"}' } });

    expect(acc.rawArgumentsForTool('write_file')).toBe(
      '{"path":"index.html","content":"<html></html>"}',
    );
    expect(acc.rawArgumentsForTool('read_file')).toBeNull();
  });
});

describe('scenario file repair turn detection', () => {
  const repairTools = [
    'read_file',
    'list_dir',
    'stat',
    'validate',
    'replace_in_file',
    'write_file',
    'append_to_file',
  ].map(tool);

  it('does not classify scenario repair prompts as immediate file writes', () => {
    const prompt =
      "[scenario check] I looked at `index.html` and the success criteria aren't met yet.\n" +
      "Signals that didn't fire: **js-parses**.\n" +
      'Exact patch candidate(s): replace_in_file({ path: "index.html", find: "board[combo[0]]]", replace: "board[combo[0]]", occurrence: "all" }). ' +
      'Whole-file `write_file` overwrites are validated and can be refused if the re-emitted HTML still has a parse error.';

    expect(isImmediateFileWriteTurn(prompt, [tool('write_file')])).toBe(false);
  });

  it('does not classify a future write_file example after prerequisite reads as immediate', () => {
    const prompt = [
      'Read all five evidence files before drafting the incident postmortem.',
      'Do not write until every evidence read succeeds.',
      'After your fifth successful read, your next tool call must be write_file({ path: "postmortem.md", content: "<complete report>" }).',
    ].join('\n');

    expect(isImmediateFileWriteTurn(prompt, [tool('read_file'), tool('write_file')])).toBe(false);
  });

  it('classifies direct first-version source creation asks as immediate file writes', () => {
    const prompt =
      'Phase 1: build the first version of the Launch Board app at `index.html`. Keep this first version monolithic: HTML, CSS, and inline JavaScript in that one file; do not create `src/` files yet. Use workspace `write_file` paths relative to the workspace root.';

    expect(isImmediateFileWriteTurn(prompt, [tool('write_file')])).toBe(true);
  });

  it('does not classify existing-codebase feature requests as immediate file writes', () => {
    const prompt =
      'Phase 2: modify the existing Launch Board codebase, do not start over. Add task priority support and preserve the Phase 1 board behavior.';

    expect(isImmediateFileWriteTurn(prompt, [tool('write_file')])).toBe(false);
  });

  it('classifies existing source-file edit requests on the direct edit surface', () => {
    const prompt =
      'Phase 2: modify the existing Launch Board codebase in `index.html`, do not start over. Use workspace `replace_in_file` or `write_file` to add a visible priority filter.';

    expect(isExistingSourceEditTurn(prompt, repairTools)).toBe(true);
  });

  it('classifies strong existing source-file follow-ups without explicit tool names', () => {
    const prompt =
      'Phase 3: continue evolving the existing Launch Board codebase in `index.html`, do not start over. Add due dates and preserve the Phase 2 priority behavior.';

    expect(isExistingSourceEditTurn(prompt, repairTools)).toBe(true);
  });

  it('classifies revision prompts for a named workspace file as existing source edits', () => {
    const prompt =
      'Revision 2 for `tracker.html`: remove the Add button — adding a habit should happen with the Enter key.';

    expect(isExistingSourceEditTurn(prompt, repairTools)).toBe(true);
  });

  it('classifies a small failing-acceptance defect as an existing source edit', () => {
    expect(isExistingSourceEditTurn(SYMPTOM_DEBUG_KICKOFF_MESSAGE, repairTools)).toBe(true);
  });

  it('does not classify broad tool surfaces or scenario repair prompts as existing source edits', () => {
    const prompt =
      'Phase 2: modify the existing Launch Board codebase in `index.html`, do not start over. Use workspace `replace_in_file` or `write_file` to add a visible priority filter.';

    expect(isExistingSourceEditTurn(prompt, [...repairTools, tool('message_gezel')])).toBe(false);
    expect(
      isExistingSourceEditTurn(
        "[scenario check] I looked at `index.html` and the success criteria aren't met yet. Use `replace_in_file`.",
        repairTools,
      ),
    ).toBe(false);
  });

  it('detects runtime repair nudges on the direct file repair surface', () => {
    expect(
      isScenarioFileRepairTurn(
        '[runtime check] I opened `index.html` in a headless browser. 2 assertion(s) failed.',
        repairTools,
      ),
    ).toBe(true);
  });

  it('detects repeated runtime repair nudges on the direct file repair surface', () => {
    expect(
      isScenarioFileRepairTurn(
        '[runtime check - attempt 2] I re-opened `index.html` after your latest edit. The SAME assertion(s) are still failing.',
        repairTools,
      ),
    ).toBe(true);
    expect(
      isScenarioFileRepairTurn(
        "[runtime check - attempt 3, STOP REWRITING] You've now rewritten `index.html` 2 time(s) and the SAME assertion(s) keep failing.",
        repairTools,
      ),
    ).toBe(true);
  });

  it('detects sniff repair nudges on the direct file repair surface', () => {
    expect(
      isScenarioFileRepairTurn(
        "[scenario check] I looked at `index.html` and the success criteria aren't met yet.",
        repairTools,
      ),
    ).toBe(true);
  });

  it('does not trigger on normal builder turns, but does trigger on repair prompts with broader tool surfaces', () => {
    expect(
      isScenarioFileRepairTurn('First move: create the workspace deliverable', repairTools),
    ).toBe(false);
    expect(
      isScenarioFileRepairTurn(
        '[runtime check] I opened `index.html` in a headless browser. 1 assertion(s) failed.',
        [...repairTools, tool('message_gezel')],
      ),
    ).toBe(true);
  });

  it('detects direct file-work asks on the compact read/write/script surface', () => {
    const directTools = [
      'read_file',
      'list_dir',
      'stat',
      'validate',
      'make_dir',
      'write_file',
      'append_to_file',
      'replace_in_file',
      'replace_lines',
      'run_nodejs_script',
    ].map(tool);
    const prompt =
      'Please clean up our customer exports. Read data/raw/customers.csv and produce the normalized out/customers.json. Write the result to out/customers.json as a single JSON array.';

    expect(isDirectFileWorkTurn(prompt, directTools)).toBe(true);
    expect(
      isDirectFileWorkTurn(
        'Please consolidate the registration sources into one clean CSV at `records/attendees.csv`. Read the source files, derive the rows, and write the result.',
        directTools,
      ),
    ).toBe(true);
    expect(isDirectFileWorkTurn(prompt, [...directTools, tool('message_gezel')])).toBe(false);
    expect(
      isDirectFileWorkTurn(
        "[scenario check] I looked at `out/customers.json` and the success criteria aren't met yet.",
        directTools,
      ),
    ).toBe(false);
  });
});

describe('scripted data-file start classification', () => {
  const target = 'out/customers.json';

  it('starts immediately for the data-wrangle-shaped on-disk script contract', () => {
    const prompt = [
      'Read data/raw/customers_a.csv, data/raw/customers_b.csv, and data/raw/legacy_export.csv and produce out/customers.json.',
      'Normalize emails, parse the mixed dates, deduplicate by email, and sort the result.',
      'If you write a Node script, have the script read the CSV files with fs.readFileSync and write out/customers.json with fs.writeFileSync.',
      'Do not hand-serialize the rows.',
    ].join(' ');

    expect(shouldPreferScriptedDataFileWork(prompt, target)).toBe(true);
    expect(shouldStartScriptedDataFileWork(prompt, target)).toBe(true);
  });

  it('does not turn a simple JSON projection into a helper-script workflow', () => {
    const prompt =
      'Read settings/base.json and write the selected theme and locale to settings/public.json as JSON.';
    expect(shouldPreferScriptedDataFileWork(prompt, 'settings/public.json')).toBe(false);
    expect(shouldStartScriptedDataFileWork(prompt, 'settings/public.json')).toBe(false);
  });

  it('keeps optional script suggestions on the normal read-first path', () => {
    const prompt =
      'Normalize data/raw/customers.csv into out/customers.json. If needed, write a Node script and run it.';
    expect(shouldPreferScriptedDataFileWork(prompt, target)).toBe(true);
    expect(shouldStartScriptedDataFileWork(prompt, target)).toBe(false);
  });

  it('respects an explicit read-then-script ordering requirement', () => {
    const prompt =
      'Read records/raw-notes.txt, then normalize the records into records/attendees.csv. Write a Node script and run it.';
    expect(shouldPreferScriptedDataFileWork(prompt, 'records/attendees.csv')).toBe(true);
    expect(shouldStartScriptedDataFileWork(prompt, 'records/attendees.csv')).toBe(false);
  });

  it('does not start a script when no distinct on-disk input is named', () => {
    const prompt =
      'Write a Node script that creates out/customers.json with a JSON array of example records.';
    expect(shouldStartScriptedDataFileWork(prompt, target)).toBe(false);
  });

  it('pins the follow-up script run to the helper that was just written', () => {
    expect(
      runNodeScriptWrongTargetError(
        { path: 'scripts/nonexistent_helper.mjs' },
        'scripts/clean_data.mjs',
      ),
    ).toMatch(/must run exactly `scripts\/clean_data\.mjs`/);
    expect(
      runNodeScriptWrongTargetError(
        { path: 'workspace/scripts/clean_data.mjs' },
        'scripts/clean_data.mjs',
      ),
    ).toBeNull();
    expect(runNodeScriptWrongTargetError({}, 'scripts/clean_data.mjs')).toMatch(
      /did not include a string path/,
    );
  });
});

describe('immediate file write salvage readiness', () => {
  const prompt =
    'First move: create the workspace deliverable. write_file({ path: "index.html", content: "..." })';

  it('does not abort and salvage a short incomplete HTML first draft', () => {
    const raw = `write_file({ path: "index.html", content: \`\n<!DOCTYPE html>\n<html><body><script>\nconst board = document.querySelector(".board");\n${'const '.padEnd(1_250, 'x')}`;

    expect(hasSalvageableImmediateFileWriteContent(raw, prompt)).toBe(false);
  });

  it('salvages as soon as the visible buffer contains a complete HTML document', () => {
    const raw =
      'write_file({ path: "index.html", content: `\n' +
      '<!DOCTYPE html><html><body><button>Play</button><script>console.log("ok")</script></body></html>` })';

    expect(hasSalvageableImmediateFileWriteContent(raw, prompt)).toBe(true);
  });

  it('still aborts extremely long incomplete HTML so the model can repair', () => {
    const raw = `write_file({ path: "index.html", content: \`\n<!DOCTYPE html>\n<html><body><script>\nconst board = document.querySelector(".board");\n${'const '.padEnd(4_200, 'x')}`;

    expect(hasSalvageableImmediateFileWriteContent(raw, prompt)).toBe(true);
  });
});

describe('scenario-repair text abort threshold', () => {
  it('keeps the tight prose cap for plain rambling', () => {
    const prose = 'I have verified the file and everything looks correct. '.repeat(60);
    expect(scenarioRepairTextAbortThreshold(prose, false)).toBe(2_048);
  });

  it('extends the cap while a fenced full-file payload is still open', () => {
    const midPayload = `Here is the corrected file:\n\`\`\`json\n{\n  "status": "ok",\n  "chapters": [\n${'    { "chapterId": "01" },\n'.repeat(80)}`;
    expect(hasInProgressFileRewritePayload(midPayload)).toBe(true);
    expect(scenarioRepairTextAbortThreshold(midPayload, false)).toBe(8_192);
  });

  it('drops back to the tight cap once the fence closes so salvage can run', () => {
    const closedPayload = 'Here is the corrected file:\n```json\n{ "status": "ok" }\n```\n';
    expect(hasInProgressFileRewritePayload(closedPayload)).toBe(false);
    expect(scenarioRepairTextAbortThreshold(closedPayload, false)).toBe(2_048);
  });

  it('extends the cap while inline tool-call markup is still open', () => {
    const midToolCall =
      '<tool_call>{"name":"write_file","arguments":{"path":"master/assembly-log.json","content":"{ \\"status\\": ';
    expect(hasInProgressFileRewritePayload(midToolCall)).toBe(true);
    const closedToolCall = `${midToolCall}\\"ok\\" }"}}</tool_call>`;
    expect(hasInProgressFileRewritePayload(closedToolCall)).toBe(false);

    const midFunction = '<function=write_file>{"path":"a.json","content":"{';
    expect(hasInProgressFileRewritePayload(midFunction)).toBe(true);
    expect(hasInProgressFileRewritePayload(`${midFunction}}"}</function>`)).toBe(false);
  });

  it('extends the cap on turns that explicitly require a whole-file rewrite', () => {
    const prose = 'Rewriting the complete file now with all six chapters restored. ';
    expect(scenarioRepairTextAbortThreshold(prose, true)).toBe(8_192);
  });
});

describe('strict alternation tool transcript fallback', () => {
  it('flattens assistant tool calls and tool outputs into alternating messages', () => {
    const flattened = flattenToolMessagesForStrictAlternation([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'start_job', arguments: '{"name":"Game"}' },
          },
        ],
      },
      { role: 'tool', content: 'created project', tool_call_id: 'call_1' },
      { role: 'tool', content: 'kickoff sent', tool_call_id: 'call_2' },
    ]);

    expect(flattened.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(flattened[2]?.content).toContain('start_job (call_1)');
    expect(flattened[3]?.content).toContain('Tool result for start_job');
    expect(flattened[3]?.content).toContain('kickoff sent');
    expect(flattened[2]?.tool_calls).toBeUndefined();
  });

  it('detects llama.cpp strict alternation template errors', () => {
    expect(
      tryParseStrictAlternationTemplateError(
        JSON.stringify({
          error: {
            message:
              'Error: Jinja Exception: Conversation roles must alternate user/assistant/user/assistant/...',
          },
        }),
      ),
    ).toBe(true);
    expect(tryParseStrictAlternationTemplateError('model load failed')).toBe(false);
  });
});

describe('compactSuccessfulWriteToolCallForTranscript', () => {
  it('replaces large successful write_file content with a compact transcript marker', () => {
    const call = {
      id: 'call_1',
      type: 'function' as const,
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: 'index.html', content: 'x'.repeat(2_500) }),
      },
    };
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;

    expect(compactSuccessfulWriteToolCallForTranscript(call, args, 'Wrote index.html')).toBe(true);

    const compacted = JSON.parse(call.function.arguments) as { path: string; content: string };
    expect(compacted.path).toBe('index.html');
    expect(compacted.content).toContain('2500 chars were written');
    expect(compacted.content).toContain('Use read_file');
    expect(compacted.content).not.toContain('x'.repeat(100));
  });

  it('leaves failed or small writes unchanged', () => {
    const small = {
      id: 'call_1',
      type: 'function' as const,
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: 'index.html', content: 'short' }),
      },
    };
    const failed = {
      id: 'call_2',
      type: 'function' as const,
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: 'index.html', content: 'x'.repeat(2_500) }),
      },
    };

    expect(
      compactSuccessfulWriteToolCallForTranscript(
        small,
        JSON.parse(small.function.arguments) as Record<string, unknown>,
        'Wrote index.html',
      ),
    ).toBe(false);
    expect(small.function.arguments).toContain('short');
    expect(
      compactSuccessfulWriteToolCallForTranscript(
        failed,
        JSON.parse(failed.function.arguments) as Record<string, unknown>,
        'ERROR: permission denied',
      ),
    ).toBe(false);
    expect(failed.function.arguments).toContain('x'.repeat(100));
  });
});

describe('single-system-message template fallback', () => {
  it('merges the stable + volatile system turns into one leading system message', () => {
    const merged = mergeSystemMessagesIntoFirst([
      { role: 'system', content: 'stable prompt' },
      { role: 'system', content: 'volatile band' },
      { role: 'user', content: 'start' },
    ]);

    expect(merged.map((m) => m.role)).toEqual(['system', 'user']);
    expect(merged[0]?.content).toBe('stable prompt\n\nvolatile band');
    expect(merged[1]?.content).toBe('start');
  });

  it('is a no-op shape for a single leading system message', () => {
    const merged = mergeSystemMessagesIntoFirst([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);

    expect(merged.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(merged[0]?.content).toBe('sys');
  });

  it('hoists a non-leading system turn into the single leading system message', () => {
    const merged = mergeSystemMessagesIntoFirst([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'mid-stream nudge' },
      { role: 'assistant', content: 'ok' },
    ]);

    // Exactly one system message, at index 0 — what Qwen's template requires.
    expect(merged.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(merged[0]?.role).toBe('system');
    expect(merged[0]?.content).toBe('sys\n\nmid-stream nudge');
    expect(merged.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('passes through untouched when there is no system message', () => {
    const merged = mergeSystemMessagesIntoFirst([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);

    expect(merged.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('detects llama.cpp single-system-message template errors', () => {
    expect(
      tryParseSystemMessageOrderingError(
        JSON.stringify({
          error: {
            message:
              "While executing CallExpression: raise_exception('System message must be at the beginning of the conversation')",
          },
        }),
      ),
    ).toBe(true);
    // Raw (non-JSON) body still matches on the stable substring.
    expect(
      tryParseSystemMessageOrderingError('...first %}\n  System message must be at the beginning'),
    ).toBe(true);
    expect(tryParseSystemMessageOrderingError('model load failed')).toBe(false);
  });
});

describe('malformed structured tool-call argument repair', () => {
  const knownWriteTools = new Set(['write_file']);

  it('repairs Gemma raw-string write_file args with a trailing path clause', () => {
    const raw =
      '"<!DOCTYPE html>\\n<html><body><div>Player X\'s Turn</div><script>const wins=[[0,1,2]];</script></body></html>\\n\\"\\"\\", path: \\"index.html\\" });\\n<|channel>thought\\n<channel|>';
    const repaired = tryRepairMalformedWriteToolArguments('write_file', raw, knownWriteTools);
    expect(repaired?.path).toBe('index.html');
    expect(repaired?.content).toContain("<div>Player X's Turn</div>");
    expect(repaired?.content).toContain('<script>const wins');
    expect(repaired?.content).not.toContain('<|channel>');
    expect(repaired?.content).not.toContain('path: "index.html"');
  });

  it('defaults Gemma raw-string write_file args to index.html when path repair captures punctuation', () => {
    const raw =
      '"<!DOCTYPE html>\\n<html><body><script>document.body.textContent=\\"ok\\";</script></body></html>\\n\\"\\"\\",path:';
    const repaired = tryRepairMalformedWriteToolArguments('write_file', raw, knownWriteTools);
    expect(repaired?.path).toBe('index.html');
    expect(repaired?.content).toContain('<script>document.body.textContent');
  });

  it('defaults Gemma raw-string HTML writes to index.html when path repair captures a product name', () => {
    const raw =
      '"<!DOCTYPE html>\\n<html><body><h1>Pet Shop</h1><script>document.body.onclick=()=>{};</script></body></html>\\n\\"\\"\\", path: \\"Premium Dog Kibble\\" });';
    const repaired = tryRepairMalformedWriteToolArguments('write_file', raw, knownWriteTools);
    expect(repaired?.path).toBe('index.html');
    expect(repaired?.content).toContain('<h1>Pet Shop</h1>');
  });

  it('keeps explicit HTML paths when repairing malformed write_file args', () => {
    const raw =
      '"<!DOCTYPE html>\\n<html><body><h1>Landing</h1><script>console.log(1);</script></body></html>\\n\\"\\"\\", path: \\"pages/landing.html\\" });';
    const repaired = tryRepairMalformedWriteToolArguments('write_file', raw, knownWriteTools);
    expect(repaired?.path).toBe('pages/landing.html');
    expect(repaired?.content).toContain('<h1>Landing</h1>');
  });

  it('normalizes invalid structured args before they are committed to chat history', () => {
    const raw =
      '"<!DOCTYPE html>\\n<html><body><button>Reset</button><script>document.body.onclick=()=>{};</script></body></html>\\n\\"\\"\\", path: \\"index.html\\" });';
    const out = normalizeMalformedStructuredToolCalls(
      [
        {
          id: 'call_write',
          type: 'function',
          function: { name: 'write_file', arguments: raw },
        },
      ],
      knownWriteTools,
    );
    expect(out.repaired).toHaveLength(1);
    expect(out.repaired[0]?.name).toBe('write_file');
    expect(out.repaired[0]?.path).toBe('index.html');
    expect(out.repaired[0]?.bytes).toBeGreaterThan(80);
    expect(out.sanitized).toEqual([]);
    expect(out.sanitizedIds).toEqual([]);
    const args = JSON.parse(out.toolCalls[0]?.function.arguments ?? '{}');
    expect(args.path).toBe('index.html');
    expect(args.content).toContain('<button>Reset</button>');
  });

  it('sanitizes unrepairable malformed args so llama-server can parse later history', () => {
    const out = normalizeMalformedStructuredToolCalls(
      [
        {
          id: 'call_weather',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":' },
        },
      ],
      new Set(['get_weather']),
    );
    expect(out.repaired).toEqual([]);
    expect(out.sanitized).toEqual(['get_weather']);
    expect(out.sanitizedIds).toEqual(['call_weather']);
    expect(out.toolCalls[0]?.function.arguments).toBe('{}');
  });

  it('sanitizes a repairable write prefix when generation ended at the output ceiling', () => {
    const out = normalizeMalformedStructuredToolCalls(
      [
        {
          id: 'call_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments:
              '{"path":"postmortem.md","content":"# Postmortem\\n\\n| Action | Owner |\\n| Add alert |',
          },
        },
      ],
      knownWriteTools,
      false,
    );
    expect(out.repaired).toEqual([]);
    expect(out.sanitized).toEqual(['write_file']);
    expect(out.sanitizedIds).toEqual(['call_write']);
    expect(out.toolCalls[0]?.function.arguments).toBe('{}');
  });
});

describe('readSseEvents', () => {
  function streamOf(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode(text));
        ctrl.close();
      },
    });
  }

  it('parses two JSON frames separated by LF-LF', async () => {
    const events: unknown[] = [];
    for await (const ev of readSseEvents(streamOf('data: {"a":1}\n\ndata: {"a":2}\n\n'))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('handles CRLF-CRLF separators', async () => {
    const events: unknown[] = [];
    for await (const ev of readSseEvents(streamOf('data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n'))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('emits the literal "[DONE]" for the terminator frame', async () => {
    const events: unknown[] = [];
    for await (const ev of readSseEvents(streamOf('data: {"x":1}\n\ndata: [DONE]\n\n'))) {
      events.push(ev);
    }
    expect(events).toEqual([{ x: 1 }, '[DONE]']);
  });

  it('ignores non-data lines (`event:`, `:keepalive`, etc.)', async () => {
    const events: unknown[] = [];
    const text = ': keepalive\n\nevent: ping\ndata: {"a":1}\n\n';
    for await (const ev of readSseEvents(streamOf(text))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 1 }]);
  });

  it('tolerates malformed data chunks without throwing', async () => {
    const events: unknown[] = [];
    const text = 'data: not-json\n\ndata: {"a":2}\n\n';
    for await (const ev of readSseEvents(streamOf(text))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 2 }]);
  });

  it('surfaces comment lines as SseComment objects when opted in', async () => {
    // ds4-server pings `: prefill` every ~5s during prompt processing —
    // the only wire signal for minutes on a 284B SSD-streamed model.
    const events: unknown[] = [];
    const text = ': prefill\n\n: prefill\n\ndata: {"a":1}\n\n';
    for await (const ev of readSseEvents(streamOf(text), { comments: true })) {
      events.push(ev);
    }
    expect(events).toEqual([{ sseComment: 'prefill' }, { sseComment: 'prefill' }, { a: 1 }]);
    expect(isSseComment(events[0])).toBe(true);
    expect(isSseComment(events[2])).toBe(false);
  });

  it('still drops comment lines by default', async () => {
    const events: unknown[] = [];
    for await (const ev of readSseEvents(streamOf(': prefill\n\ndata: {"a":1}\n\n'))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 1 }]);
  });
});

describe('tryParseContextOverflow', () => {
  it('extracts structured fields from the exceed_context_size_error body', () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        type: 'exceed_context_size_error',
        n_prompt_tokens: 48514,
        n_ctx: 16384,
        message: 'request (48514 tokens) exceeds the available context size (16384 tokens)',
      },
    });
    expect(tryParseContextOverflow(body)).toEqual({ promptTokens: 48514, nCtx: 16384 });
  });

  it('falls back to regex-parsing the message when structured fields are missing', () => {
    // Older llama-server builds may omit n_prompt_tokens / n_ctx —
    // regex the human text as a backup.
    const body = JSON.stringify({
      error: {
        code: 400,
        type: 'exceed_context_size_error',
        message: 'request (5000 tokens) exceeds the available context size (4096 tokens)',
      },
    });
    expect(tryParseContextOverflow(body)).toEqual({ promptTokens: 5000, nCtx: 4096 });
  });

  it('returns null for unrelated 400 bodies', () => {
    expect(
      tryParseContextOverflow(JSON.stringify({ error: { code: 400, type: 'other' } })),
    ).toBeNull();
    expect(tryParseContextOverflow('not json at all')).toBeNull();
    expect(tryParseContextOverflow('')).toBeNull();
  });
});

describe('tryParseToolCallParseError', () => {
  it('detects llama-server tool-call JSON parse failures and extracts the partial fragment', () => {
    const body = JSON.stringify({
      error: {
        code: 500,
        type: 'server_error',
        message:
          "Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 312: syntax error while parsing value - invalid string: missing closing quote; last read: '\"Generate 2-3 new'",
      },
    });
    expect(tryParseToolCallParseError(body)).toEqual({ partial: '"Generate 2-3 new' });
  });

  it('keeps apostrophes inside llama-server last-read fragments', () => {
    const body = JSON.stringify({
      error: {
        code: 500,
        type: 'server_error',
        message:
          "Failed to parse tool call arguments as JSON: parse error; last read: '\"<div>Player X's Turn</div>'",
      },
    });
    expect(tryParseToolCallParseError(body)).toEqual({
      partial: '"<div>Player X\'s Turn</div>',
    });
  });

  it('returns an empty partial when the message lacks a `last read` clause', () => {
    const body = JSON.stringify({
      error: {
        code: 500,
        type: 'server_error',
        message: 'Failed to parse tool call arguments as JSON: catastrophic error',
      },
    });
    expect(tryParseToolCallParseError(body)).toEqual({ partial: '' });
  });

  it('returns null for unrelated 500 bodies', () => {
    expect(
      tryParseToolCallParseError(
        JSON.stringify({ error: { code: 500, message: 'something else broke' } }),
      ),
    ).toBeNull();
    expect(tryParseToolCallParseError('not json at all')).toBeNull();
    expect(tryParseToolCallParseError('')).toBeNull();
  });
});

describe('LlamaCppSession graceful context-overflow handling', () => {
  it('surfaces an actionable error on exceed_context_size_error instead of raw JSON', async () => {
    globalThis.fetch = (async () => {
      const body = JSON.stringify({
        error: {
          code: 400,
          message: 'request (48514 tokens) exceeds the available context size (16384 tokens)',
          type: 'exceed_context_size_error',
          n_prompt_tokens: 48514,
          n_ctx: 16384,
        },
      });
      return new Response(body, {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys' });
    let caught: Error | null = null;
    try {
      await session.sendAndWait('hi');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeTruthy();
    expect(caught?.message).toContain('working memory');
    expect(caught?.message).toContain('48,514');
    expect(caught?.message).toContain('16,384');
    // Must be flagged actionable so the UI surfaces it as a
    // user-fixable problem rather than a generic crash.
    expect((caught as unknown as { isActionable?: boolean })?.isActionable).toBe(true);
  });

  it('attempts reactive compaction before throwing on exceed_context_size_error', async () => {
    // Mirror of the toolParseFail recovery path. When `requestCompaction`
    // is wired and the prior transcript can be folded, the overflow
    // should NOT bubble — the model gets a second chance with a shorter
    // prompt. The petshop eval hit 84k tokens vs 65k ctx
    // and ChatManager threw because this branch didn't try compaction.
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        const body = JSON.stringify({
          error: {
            code: 400,
            type: 'exceed_context_size_error',
            message: 'request (84205 tokens) exceeds the available context size (65536 tokens)',
            n_prompt_tokens: 84205,
            n_ctx: 65536,
          },
        });
        return new Response(body, {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Post-compaction retry: clean SSE stream with a final reply.
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'recovered ' } }] },
        { choices: [{ index: 0, delta: { content: 'reply' } }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;
    let compactionCalls = 0;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      numCtx: 1000, // generous — the reactive path uses force:true, not the ratio gate
    });
    const session = await provider.createSession({
      systemMessage: 'sys',
      priorMessages: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' },
        { role: 'assistant', content: 'A2' },
      ],
      requestCompaction: async () => {
        compactionCalls++;
        return { syntheticContent: '[Earlier… compacted]' };
      },
    });
    const text = await session.sendAndWait('please retry');
    expect(text).toBe('recovered reply');
    expect(fetchCount).toBe(2); // first 400 (overflow), then 200 after compaction
    expect(compactionCalls).toBe(1);
  });

  it('falls through to actionable overflow error when reactive compaction is unavailable', async () => {
    // No requestCompaction wired → the overflow path can't recover and
    // throws the existing actionable error. Pinning the gating contract.
    globalThis.fetch = (async () => {
      const body = JSON.stringify({
        error: {
          code: 400,
          type: 'exceed_context_size_error',
          message: 'request (48514 tokens) exceeds the available context size (16384 tokens)',
          n_prompt_tokens: 48514,
          n_ctx: 16384,
        },
      });
      return new Response(body, {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys' });
    let caught: Error | null = null;
    try {
      await session.sendAndWait('hi');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toContain('working memory');
    expect((caught as unknown as { isActionable?: boolean })?.isActionable).toBe(true);
  });

  it('keeps the prefill budget while only framing pulses arrive, then switches to the streaming budget', async () => {
    // Regression: llama-server emits framing pulses (no delta content)
    // before it has decoded anything. The watchdog used to treat the
    // first such pulse as "generation started" and rearm with
    // `streamingIdleMs` — which false-kills a long prefill whenever the
    // streaming budget is the TIGHTER of the two, exactly the eval
    // harness's config (120s streaming vs 600s prefill). Wild-caught in
    // the 2026-07-25 craftbook matrix: 57 aborts, all "0 chars in 120s",
    // all on long repair-loop prompts, all 13 trials lost.
    const encoder = new TextEncoder();
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // Two bare framing pulses — wire alive, nothing decoded yet.
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'),
          );
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{}}]}\n\n'));
          // Then a real token, then finish.
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const timeouts: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    // Record every watchdog budget the provider arms. The idle timer is
    // the only long-lived timeout this path sets.
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number' && ms >= 1_000) timeouts.push(ms);
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof globalThis.setTimeout;

    try {
      const provider = new LlamaCppProvider({
        baseUrl: 'http://llama.test',
        streamingIdleMs: 120_000,
        preFirstByteIdleMs: 600_000,
      });
      const session = await provider.createSession({ systemMessage: 'sys' });
      const out = await session.sendAndWait('hi');
      expect(out).toContain('hello');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // Discriminating counts, not mere presence: the initial arm plus BOTH
    // framing pulses must use the prefill budget, and only the real
    // content delta may arm the streaming one. Under the old behavior
    // these invert (1× prefill, 3× streaming), which is the false-kill.
    const prefillArms = timeouts.filter((ms) => ms === 600_000).length;
    const streamingArms = timeouts.filter((ms) => ms === 120_000).length;
    // Initial arm + both framing pulses (+ the content chunk's own arm,
    // which fires before the chunk is inspected and is then promoted).
    expect(prefillArms).toBeGreaterThanOrEqual(3);
    expect(streamingArms).toBeGreaterThanOrEqual(1);
    // And the streaming budget must arm only after every prefill arm.
    expect(timeouts.lastIndexOf(600_000)).toBeLessThan(timeouts.indexOf(120_000));
  });

  it('keeps the generous budget while only private reasoning streams (nothing to salvage)', async () => {
    // Wild-caught: e4b streams hundreds of reasoning chunks with zero visible
    // content, then pauses. Under the tightened eval budget that pause killed
    // the turn — and because `turnContent` was empty there was nothing to
    // salvage, so the early abort bought nothing. Measured: 3 books went
    // 0/3 → 3/3 (15 idle aborts → 0) once the budget stopped applying here.
    const encoder = new TextEncoder();
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n'),
          );
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"reasoning_content":"still thinking..."}}]}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const timeouts: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number' && ms >= 1_000) timeouts.push(ms);
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof globalThis.setTimeout;

    try {
      const provider = new LlamaCppProvider({
        baseUrl: 'http://llama.test',
        streamingIdleMs: 120_000,
        preFirstByteIdleMs: 600_000,
      });
      const session = await provider.createSession({ systemMessage: 'sys' });
      await session.sendAndWait('hi');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // Both reasoning chunks must have armed the GENEROUS budget — the tight
    // one may only appear from the visible-content delta onward.
    const firstTight = timeouts.indexOf(120_000);
    const generousBeforeTight = timeouts.slice(0, firstTight).filter((ms) => ms === 600_000).length;
    expect(firstTight).toBeGreaterThan(-1);
    expect(generousBeforeTight).toBeGreaterThanOrEqual(3);
  });

  it('mid-loop compaction fires when in-memory transcript crosses ~70% of numCtx', async () => {
    // Build a session with prior messages totaling ~80% of numCtx,
    // then exercise the private maybeCompactMidLoop helper directly
    // (driving the full tool loop end-to-end here would require a
    // mocked McpBridgePool which lives outside this test file's
    // scope). The helper is the load-bearing piece — if its
    // pressure-check + slice + splice are right, the iteration-2
    // hook in the tool loop just calls it.
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      numCtx: 100, // tokens; ~400 chars by the 4:1 heuristic
    });
    const compactionCalls: Array<{
      priorMessages: Array<{ role: string; content: string }>;
      estimatedTokens: number;
      numCtx: number;
    }> = [];
    const session = await provider.createSession({
      systemMessage: 'sys-prompt',
      // 4 prior messages of ~80 chars each = 320 chars ≈ 80 tokens = 80% ratio.
      priorMessages: [
        { role: 'user', content: 'A'.repeat(80) },
        { role: 'assistant', content: 'B'.repeat(80) },
        { role: 'user', content: 'C'.repeat(80) },
        { role: 'assistant', content: 'D'.repeat(80) },
      ],
      requestCompaction: async (params) => {
        compactionCalls.push(params);
        return { syntheticContent: '[Earlier in this conversation, summarized: 4 turns]' };
      },
    });
    // Simulate the start of a turn so currentTurnStartIdx is set as
    // sendAndWaitInner would set it (right before pushing user msg).
    const internal = session as unknown as {
      currentTurnStartIdx: number;
      compactedThisTurn: boolean;
      maybeCompactMidLoop: () => Promise<void>;
      messages: Array<{ role: string; content: string }>;
    };
    internal.currentTurnStartIdx = internal.messages.length;
    internal.compactedThisTurn = false;
    internal.messages.push({ role: 'user', content: 'short prompt' });
    // Imitate the iteration-2 hook: a tool result was just pushed.
    internal.messages.push({
      role: 'assistant',
      content: '',
    });
    internal.messages.push({
      role: 'tool',
      content: 'TOOL OUTPUT 12345',
    });
    await internal.maybeCompactMidLoop();
    expect(compactionCalls.length).toBe(1);
    // Compaction should have seen the 4 priorMessages (everything
    // before the current turn's user msg, excluding system).
    expect(compactionCalls[0]!.priorMessages).toHaveLength(4);
    expect(compactionCalls[0]!.priorMessages[0]!.content).toBe('A'.repeat(80));
    // After compaction, the prior should be replaced by one synthesis.
    // Layout: [system, synthesis, currentUserMsg, '', toolResult]
    expect(internal.messages).toHaveLength(5);
    expect(internal.messages[0]!.role).toBe('system');
    expect(internal.messages[1]!.role).toBe('assistant');
    expect(internal.messages[1]!.content).toContain('summarized');
    expect(internal.messages[2]!.content).toBe('short prompt');
    expect(internal.compactedThisTurn).toBe(true);
    // currentTurnStartIdx now points at index 2 (the user msg, after
    // [system, synthesis]).
    expect(internal.currentTurnStartIdx).toBe(2);
  });

  it('preserves layered system bands when compacting prior conversation', async () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', numCtx: 100 });
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const session = await provider.createSession({
      systemMessage: 'stable system',
      volatileContext: 'volatile project + recall context',
      priorMessages: [
        { role: 'user', content: 'A'.repeat(80) },
        { role: 'assistant', content: 'B'.repeat(80) },
      ],
      requestCompaction: async ({ priorMessages }) => {
        seen.push(priorMessages);
        return { syntheticContent: 'conversation synthesis' };
      },
    });
    const internal = session as unknown as {
      currentTurnStartIdx: number;
      compactedThisTurn: boolean;
      maybeCompactMidLoop: (opts?: { force?: boolean }) => Promise<boolean>;
      messages: Array<{ role: string; content: string }>;
    };
    internal.currentTurnStartIdx = internal.messages.length;
    internal.compactedThisTurn = false;
    internal.messages.push({ role: 'user', content: 'current turn' });

    expect(await internal.maybeCompactMidLoop({ force: true })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      { role: 'user', content: 'A'.repeat(80) },
      { role: 'assistant', content: 'B'.repeat(80) },
    ]);
    expect(internal.messages.map((m) => [m.role, m.content])).toEqual([
      ['system', 'stable system'],
      ['system', 'volatile project + recall context'],
      ['assistant', 'conversation synthesis'],
      ['user', 'current turn'],
    ]);
    expect(internal.currentTurnStartIdx).toBe(3);
  });

  it('does not call a volatile band plus duplicated first user turn prior conversation', async () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', numCtx: 100 });
    let compactionCalls = 0;
    const session = await provider.createSession({
      systemMessage: 'stable system',
      volatileContext: 'volatile recall context',
      // Reproduces the old auto-recall replay bug. Even if a caller seeds the
      // current user once, it is only one conversational message—not enough
      // history to summarize, and the system band must never count toward it.
      priorMessages: [{ role: 'user', content: 'hello' }],
      requestCompaction: async () => {
        compactionCalls++;
        return { syntheticContent: 'should not happen' };
      },
    });
    const warnings: string[] = [];
    session.onWarning?.((warning) => warnings.push(warning));
    const internal = session as unknown as {
      currentTurnStartIdx: number;
      compactedThisTurn: boolean;
      maybeCompactMidLoop: (opts?: { force?: boolean }) => Promise<boolean>;
      messages: Array<{ role: string; content: string }>;
    };
    internal.currentTurnStartIdx = internal.messages.length;
    internal.compactedThisTurn = false;
    internal.messages.push({ role: 'user', content: 'hello' });

    expect(await internal.maybeCompactMidLoop({ force: true })).toBe(false);
    expect(compactionCalls).toBe(0);
    expect(warnings).not.toContain(
      'Compacted earlier conversation to free up working window for the current turn.',
    );
  });

  it("condenses THIS turn's older tool results — the blind spot prior-fold cannot reach", async () => {
    // The in-turn overflow shape: no prior transcript to fold (msgs=1),
    // so `maybeCompactMidLoop` returns false and the manager's force-fit
    // sees nothing in `record.messages` either. Only this layer can free
    // room. Wild-caught: 4 craftbooks overflowing by 111-919 tokens.
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', numCtx: 2_000 });
    const session = await provider.createSession({ systemMessage: 'sys' });
    const internal = session as unknown as {
      currentTurnStartIdx: number;
      messages: Array<{ role: string; content: string; tool_call_id?: string }>;
      condenseInTurnToolResults: () => number;
    };
    internal.currentTurnStartIdx = internal.messages.length;
    internal.messages.push({ role: 'user', content: 'do the thing' });
    // Four bulky in-turn tool results — the accumulated loop.
    for (let i = 0; i < 4; i++) {
      internal.messages.push({ role: 'assistant', content: '' });
      internal.messages.push({
        role: 'tool',
        content: `RESULT-${i} ${'x'.repeat(3_000)}`,
        tool_call_id: `call-${i}`,
      });
    }
    const before = internal.messages.length;
    const reclaimed = internal.condenseInTurnToolResults();

    expect(reclaimed).toBeGreaterThan(0);
    // Structure is preserved exactly — pairing must survive or the chat
    // template breaks.
    expect(internal.messages).toHaveLength(before);
    expect(internal.messages.filter((m) => m.role === 'tool')).toHaveLength(4);
    expect(internal.messages.filter((m) => m.tool_call_id).map((m) => m.tool_call_id)).toEqual([
      'call-0',
      'call-1',
      'call-2',
      'call-3',
    ]);
    // The two NEWEST results stay verbatim (the model needs its latest
    // observation); older ones shrink.
    const toolMsgs = internal.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs[0]!.content.length).toBeLessThan(3_000);
    expect(toolMsgs[2]!.content).toContain('x'.repeat(3_000));
    expect(toolMsgs[3]!.content).toContain('x'.repeat(3_000));
    // The user message that opened the turn is never touched.
    expect(internal.messages[internal.currentTurnStartIdx]!.content).toBe('do the thing');
  });

  it('in-turn condensation reports 0 when there is nothing safely shrinkable', async () => {
    // Honest "this layer cannot help" signal: with only short results (or
    // only the protected newest ones), the caller must fall through to the
    // actionable error rather than spin.
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', numCtx: 100 });
    const session = await provider.createSession({ systemMessage: 'sys' });
    const internal = session as unknown as {
      currentTurnStartIdx: number;
      messages: Array<{ role: string; content: string }>;
      condenseInTurnToolResults: () => number;
    };
    internal.currentTurnStartIdx = internal.messages.length;
    internal.messages.push({ role: 'user', content: 'go' });
    internal.messages.push({ role: 'tool', content: 'tiny' });
    expect(internal.condenseInTurnToolResults()).toBe(0);
  });

  it('mid-loop compaction does NOT fire below the threshold', async () => {
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      numCtx: 1000,
    });
    const compactionCalls: number[] = [];
    const session = await provider.createSession({
      systemMessage: 'sys',
      priorMessages: [
        { role: 'user', content: 'small' },
        { role: 'assistant', content: 'reply' },
      ],
      requestCompaction: async () => {
        compactionCalls.push(1);
        return { syntheticContent: 'should-not-be-used' };
      },
    });
    const internal = session as unknown as {
      currentTurnStartIdx: number;
      compactedThisTurn: boolean;
      maybeCompactMidLoop: () => Promise<void>;
      messages: Array<{ role: string }>;
    };
    internal.currentTurnStartIdx = internal.messages.length;
    internal.compactedThisTurn = false;
    internal.messages.push({ role: 'user' });
    await internal.maybeCompactMidLoop();
    expect(compactionCalls.length).toBe(0);
    expect(internal.compactedThisTurn).toBe(false);
  });

  it('mid-loop compaction is bounded to once per turn', async () => {
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      numCtx: 100,
    });
    let calls = 0;
    const session = await provider.createSession({
      systemMessage: 'sys',
      priorMessages: [
        { role: 'user', content: 'X'.repeat(80) },
        { role: 'assistant', content: 'Y'.repeat(80) },
        { role: 'user', content: 'X'.repeat(80) },
        { role: 'assistant', content: 'Y'.repeat(80) },
      ],
      requestCompaction: async () => {
        calls++;
        return { syntheticContent: 'synth' };
      },
    });
    const internal = session as unknown as {
      currentTurnStartIdx: number;
      compactedThisTurn: boolean;
      maybeCompactMidLoop: () => Promise<void>;
      messages: Array<{ role: string; content: string }>;
    };
    internal.currentTurnStartIdx = internal.messages.length;
    internal.compactedThisTurn = false;
    internal.messages.push({ role: 'user', content: 'p' });
    await internal.maybeCompactMidLoop();
    // Now pretend more tool results pile in — pressure stays high.
    internal.messages.push({ role: 'tool', content: 'X'.repeat(200) });
    await internal.maybeCompactMidLoop();
    await internal.maybeCompactMidLoop();
    expect(calls).toBe(1);
  });

  it('recovers from a tool-call JSON parse 500 by compacting + retrying when compaction is wired (option B)', async () => {
    // Reactive recovery path: a tool-call parse 500 fires (model's
    // args got truncated mid-string), `requestCompaction` is wired,
    // and the next request succeeds with the compacted transcript.
    // The user sees a clean reply — no fatal error, no
    // session-killing warning.
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        // First request: 500 with the parse-error body.
        const body = JSON.stringify({
          error: {
            code: 500,
            type: 'server_error',
            message:
              "Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 312: syntax error while parsing value - invalid string: missing closing quote; last read: '\"Generate 2-3 new'",
          },
        });
        return new Response(body, {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Second request (post-compaction retry): clean SSE stream
      // with a final assistant text and no tool calls.
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'recovered ' } }] },
        { choices: [{ index: 0, delta: { content: 'reply' } }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
        '[DONE]',
      ]);
    }) as typeof fetch;

    let compactionCalls = 0;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      numCtx: 1000, // generous: forces the ratio gate to NOT fire proactively
    });
    const session = await provider.createSession({
      systemMessage: 'sys',
      // 4 prior messages, well below the 700-token (70%) ratio so
      // the proactive iteration-2 hook never fires. The reactive
      // path uses `force: true` and skips the ratio check, which is
      // exactly the behavior we're testing.
      priorMessages: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' },
        { role: 'assistant', content: 'A2' },
      ],
      requestCompaction: async () => {
        compactionCalls++;
        return { syntheticContent: '[Earlier… compacted]' };
      },
    });
    const warnings: string[] = [];
    session.onWarning?.((w) => warnings.push(w));

    const text = await session.sendAndWait('please retry');
    expect(text).toBe('recovered reply');
    expect(fetchCount).toBe(2); // first 500, then 200 after compaction
    expect(compactionCalls).toBe(1); // forced once on the 500
    // The "compacted earlier conversation" warning DOES fire (it's
    // user-visible feedback that we did some work), but the
    // "session was cut off" warning must NOT — we successfully
    // recovered, the user got their reply.
    expect(warnings.some((w) => w.includes('Compacted earlier conversation'))).toBe(true);
    expect(warnings.some((w) => w.includes('cut off mid-string'))).toBe(false);
  });

  it('falls through to the survivable-warning path when reactive compaction is unavailable', async () => {
    // No requestCompaction wired → the 500 path can't recover, falls
    // through to the existing warning + clean turn end. Same shape
    // as the original test below but kept here for symmetry: makes
    // the gating contract explicit.
    globalThis.fetch = (async () => {
      const body = JSON.stringify({
        error: {
          code: 500,
          type: 'server_error',
          message:
            "Failed to parse tool call arguments as JSON: parse error at line 1, column 100: invalid string: missing closing quote; last read: '\"unfinished'",
        },
      });
      return new Response(body, {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys' });
    // No requestCompaction in opts.
    const warnings: string[] = [];
    session.onWarning?.((w) => warnings.push(w));
    const text = await session.sendAndWait('hi');
    expect(text).toBe('');
    expect(warnings.some((w) => w.includes('cut off mid-string'))).toBe(true);
    expect(warnings.some((w) => w.includes('Compacted earlier'))).toBe(false);
  });

  it('aborts with a pre-first-byte error when the stream opens but never produces a chunk', async () => {
    // Repro for the hung-runtime bug: llama-server accepted the
    // request, opened the SSE stream, then never sent any chunks (the
    // model is stuck on prefill, KV-cache eviction, or has wedged on a
    // tool-call parse 500 it didn't surface as 500). Pre-fix, the
    // session's `await sendAndWait` hung indefinitely and the engine
    // pill stayed at "Preparing" forever. Post-fix, the watchdog
    // aborts after `preFirstByteIdleMs` and the session throws a
    // clear "no generated tokens" error so the runtime can publish `done`.
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(streamCtrl) {
          // Wire abort → stream error so the for-await sees a real
          // AbortError instead of waiting forever on a synthetic
          // ReadableStream that has no other way to terminate. In
          // production this happens automatically because real fetch
          // tears down the underlying connection when aborted.
          if (signal) {
            const onAbort = () => streamCtrl.error(new DOMException('aborted', 'AbortError'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;
    // 50ms cap keeps the test fast — production default is 5 min.
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      preFirstByteIdleMs: 50,
      streamingIdleMs: 60_000,
    });
    const session = await provider.createSession({ systemMessage: 'sys' });
    await expect(session.sendAndWait('hi')).rejects.toThrow(/no generated tokens/i);
  });

  it('salvages partial output when the model goes silent after streaming some content', async () => {
    // Streaming-idle counterpart with the salvage behavior:
    // stream produced real content (so the first-byte budget was
    // satisfied) but then went silent. Previously the watchdog
    // would throw after `streamingIdleMs`, discarding the buffered
    // text and leaving the orchestrator with nothing. Now the same
    // idle abort fires, but if `turnContent.length > 0` the session
    // commits the partial buffer as the assistant turn with a warning
    // attached — keeping the eval harness's retry-loop from killing
    // a trial that produced usable output. See provider.ts ~line 1423
    // for the salvage block and `recoveredFromIdleStall`.
    const encoder = new TextEncoder();
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(streamCtrl) {
          // One real delta, then nothing. The reset-on-chunk path
          // flips `idlePhase` to 'streaming', so the next abort uses
          // the mid-stream message and budget.
          const chunk = {
            choices: [{ delta: { content: 'partial' }, finish_reason: null }],
          };
          streamCtrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          if (signal) {
            const onAbort = () => streamCtrl.error(new DOMException('aborted', 'AbortError'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      preFirstByteIdleMs: 60_000,
      streamingIdleMs: 50,
    });
    const session = await provider.createSession({ systemMessage: 'sys' });
    const warnings: string[] = [];
    session.onWarning?.((w) => warnings.push(w));
    const text = await session.sendAndWait('hi');
    // Partial buffer is returned as the assistant turn.
    expect(text).toBe('partial');
    // A warning surfaces the mid-stream salvage so the orchestrator
    // and UI can flag the truncated response to the user.
    expect(warnings.some((w) => /silent.*mid-generation.*salvaging/i.test(w))).toBe(true);
  });

  it('does NOT abort post-reasoning while the engine is still decoding a buffered tool call', async () => {
    // The gemma4-12b stall: `peg-gemma4` buffers a native
    // tool call and emits NO SSE delta until it parses, so a large
    // write_file looks identical to a wedged engine. The watchdog must
    // consult the engine's KV-cache growth (/slots) before aborting —
    // a rising cache means "still decoding," so re-arm and let the
    // buffered result land instead of false-killing a live turn.
    const encoder = new TextEncoder();
    const holder: { session?: { notifyReasoningEnded: () => void } } = {};
    let slotsPolls = 0;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/slots')) {
        // KV cache grows on every poll → probe reports "still decoding."
        slotsPolls += 1;
        return new Response(JSON.stringify([{ id: 0, n_cache_tokens: 8000 + slotsPolls * 100 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(streamCtrl) {
          // Reasoning ended; then the engine decodes a buffered tool call
          // with ZERO deltas across several watchdog windows before the
          // result finally arrives.
          holder.session?.notifyReasoningEnded();
          if (signal) {
            const onAbort = () => streamCtrl.error(new DOMException('aborted', 'AbortError'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
          setTimeout(() => {
            streamCtrl.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' }, finish_reason: null }] })}\n\n`,
              ),
            );
            streamCtrl.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 8000, completion_tokens: 500 } })}\n\n`,
              ),
            );
            streamCtrl.enqueue(encoder.encode('data: [DONE]\n\n'));
            streamCtrl.close();
          }, 160);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      postReasoningWatchdogMs: 40,
      streamingIdleMs: 60_000,
      preFirstByteIdleMs: 60_000,
    });
    const session = await provider.createSession({ systemMessage: 'sys' });
    holder.session = session as unknown as { notifyReasoningEnded: () => void };

    const reply = await session.sendAndWait('hi');
    // Buffered output landed; the watchdog never false-fired.
    expect(reply).toBe('Done.');
    // The probe was consulted (watchdog fired but re-armed on cache growth).
    expect(slotsPolls).toBeGreaterThan(0);
  });

  it('aborts post-reasoning when the engine is genuinely silent (KV cache static)', async () => {
    // The other side of the probe: reasoning ended, no deltas arrive,
    // AND the KV cache is NOT growing → the engine really did go silent.
    // The watchdog must still fire (the original safety net).
    const holder: { session?: { notifyReasoningEnded: () => void } } = {};
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/slots')) {
        // Static cache → no decode progress.
        return new Response(JSON.stringify([{ id: 0, n_cache_tokens: 8000 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(streamCtrl) {
          holder.session?.notifyReasoningEnded();
          if (signal) {
            const onAbort = () => streamCtrl.error(new DOMException('aborted', 'AbortError'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
          // Never enqueues, never closes — true silence.
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      postReasoningWatchdogMs: 40,
      streamingIdleMs: 60_000,
      preFirstByteIdleMs: 60_000,
    });
    const session = await provider.createSession({ systemMessage: 'sys' });
    holder.session = session as unknown as { notifyReasoningEnded: () => void };

    await expect(session.sendAndWait('hi')).rejects.toThrow(/post-reasoning silent stall/i);
  });

  it('survives a tool-call JSON parse 500 with a warning instead of killing the session', async () => {
    // Reproduces the failure mode from the field: a small local
    // model gets squeezed for context mid-tool-call, its args get
    // truncated mid-string, llama-server's strict JSON parser
    // throws a 500. Pre-fix, this terminated the chat session
    // with a raw `[llama-cpp] /v1/chat/completions returned 500`
    // error. Post-fix, the session emits a warning event, returns
    // empty completion text, and stays alive for the user to retry.
    globalThis.fetch = (async () => {
      const body = JSON.stringify({
        error: {
          code: 500,
          type: 'server_error',
          message:
            "Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 312: syntax error while parsing value - invalid string: missing closing quote; last read: '\"Generate 2-3 new'",
        },
      });
      return new Response(body, {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys' });
    const warnings: string[] = [];
    session.onWarning?.((w) => warnings.push(w));
    const text = await session.sendAndWait('hi');
    expect(text).toBe('');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('cut off mid-string');
    expect(warnings[0]).toContain('llamaCppNumCtx');
  });
});

describe('LlamaCppProvider pool lifecycle', () => {
  function fakePoolSupervisor(stops: { n: number }): NativeEngineSupervisor {
    return {
      async ensureRunning() {
        return { command: 'fake', args: [], baseUrl: 'http://127.0.0.1:18099' };
      },
      markUsed() {},
      async stop() {
        stops.n++;
      },
    } as unknown as NativeEngineSupervisor;
  }

  it('shutdown poisons the provider — createSession refuses to respawn the engine', async () => {
    const stops = { n: 0 };
    const provider = new LlamaCppProvider({ supervisor: fakePoolSupervisor(stops) });
    await provider.shutdown();
    expect(stops.n).toBe(1);
    await expect(provider.createSession({ systemMessage: 's' })).rejects.toThrow(/disposed/);
  });

  // Regression: the tool loop acquires a GPU lease per iteration and normally
  // releases it in that iteration's `cleanupTurn`. The bounded-repair guardrails
  // throw ~1000 lines BEFORE `cleanupTurn` is installed, so those throws used to
  // escape with the lease still held. A leaked lease blocked EVERY later
  // acquirer forever — the whole daemon went silent with a healthy, idle engine
  // until gezeld restarted. Wild-caught on qwen3.6-35b-a3b-q8 /
  // conflict-synthesis (2026-08-07): a repair turn sat 309s having never reached
  // the engine, and a second session starved 941s behind it.
  //
  // Drives the real trigger — `prerequisite source-read repair exceeded its
  // bounded read allowance` — by burning read-only calls on an unrelated file so
  // the required read never lands. A fetch-level throw does NOT reproduce this:
  // that path is already caught and cleaned up.
  it('releases the GPU lease when a bounded-repair guardrail throws', async () => {
    const stops = { n: 0 };
    const arbiter = new GpuArbiter({ policy: 'swap', log: () => {} });
    const fetchImpl = (async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_read_unrelated',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"unrelated.md"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ])) as unknown as typeof fetch;

    const provider = new LlamaCppProvider({
      supervisor: fakePoolSupervisor(stops),
      arbiter,
      fetchImpl,
    });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_file' || name === 'write_file',
      callTool: async (_name: string, args: Record<string, unknown>) =>
        `contents of ${String(args.path)}`,
    };

    const prompt = [
      "[scenario check] I looked at `synthesis.md` and the success criteria aren't met yet.",
      'Specific failure: source-read provenance is missing.',
      'SOURCE_READ_REQUIRED: the final claims are not backed by successful, ordered source reads.',
      'First call read_file on memo-product.md.',
      'Then patch `synthesis.md` using only the values you observed in those files.',
    ].join(' ');
    expect(extractPrerequisiteRepairReadPaths(prompt).length).toBeGreaterThan(0);

    await expect(session.sendAndWait(prompt)).rejects.toThrow(/bounded read allowance/);

    // The lease must be free. Before the fix this call never settled, and every
    // other session in the install was stuck behind it.
    const release = await arbiter.acquireLease('llm');
    expect(typeof release).toBe('function');
    release();
  });

  it('shutdown unregisters its keyed llm evictor so later image acquires skip it', async () => {
    const stops = { n: 0 };
    const arbiter = new GpuArbiter({ policy: 'swap', log: () => {} });
    const provider = new LlamaCppProvider({
      supervisor: fakePoolSupervisor(stops),
      arbiter,
      evictorOwnerId: 'llama-cpp/m#0',
    });
    await provider.shutdown();
    expect(stops.n).toBe(1);
    await arbiter.acquire('image');
    // Not stopped a second time — the registration is gone.
    expect(stops.n).toBe(1);
  });

  it('listModels enumerates the installed catalog when a manager is wired', async () => {
    const manager = {
      listInstalled: async () => [
        {
          id: 'qwen-9b',
          name: 'Qwen 9B',
          approxSizeBytes: 6.2 * 1024 ** 3,
          contextWindow: 32768,
        },
        { id: 'gemma-4b', name: 'Gemma 4B', approxSizeBytes: 3 * 1024 ** 3 },
      ],
    } as unknown as import('./models.js').LlamaCppModelManager;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://127.0.0.1:1',
      modelManager: manager,
      defaultModel: 'resident-model',
    });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(['qwen-9b', 'gemma-4b']);
    expect(models[0]!.name).toContain('Qwen 9B');
    expect(models[0]!.name).toContain('32k ctx');
    expect(models[0]!.contextWindow).toBe(32768);
    expect(models[1]!.contextWindow).toBeUndefined();
  });

  it('listModels falls back to the single running-config entry without a manager', async () => {
    const provider = new LlamaCppProvider({
      baseUrl: 'http://127.0.0.1:1',
      defaultModel: 'served-model',
    });
    const models = await provider.listModels();
    expect(models).toEqual([{ id: 'served-model', name: 'served-model', supportsTools: true }]);
  });
});

describe('gate surgical edit turn detection (D4 gap: Theme B mode)', () => {
  const repairTools = [
    'read_file',
    'validate',
    'replace_in_file',
    'replace_lines',
    'write_file',
  ].map(tool);
  const gateNudge =
    'GATE_TARGETED_EDIT: The gate rejected `report.md` — minBytes 500 unmet (312 bytes). ' +
    'Fix exactly what the verdict names with replace_in_file or replace_lines; do not rewrite the file.';

  it('fires on the escalation marker when patch tools are on the surface', () => {
    expect(isGateSurgicalEditTurn(gateNudge, repairTools)).toBe(true);
  });

  it('requires the marker — a raw gate verdict without it does not trip the mode', () => {
    const rawVerdict =
      'The gate rejected `report.md`: minBytes 500 unmet (312 bytes). Add the missing sections.';
    expect(isGateSurgicalEditTurn(rawVerdict, repairTools)).toBe(false);
  });

  it('loses to scenario-repair prompts and to surfaces without patch tools', () => {
    const scenarioShaped =
      "[scenario check] I looked at `report.md` and the success criteria aren't met yet.\nGATE_TARGETED_EDIT: fix it.";
    expect(isGateSurgicalEditTurn(scenarioShaped, repairTools)).toBe(false);
    expect(isGateSurgicalEditTurn(gateNudge, [tool('write_file')])).toBe(false);
  });

  it('a kit-clamped (bridge-filtered) tools array still trips it when replace_in_file survives', () => {
    // The D4 repair clamp narrows the bridge surface to the repair set;
    // the provider mode detector receives that filtered array and must
    // still engage — the fence and the mode compose.
    const clamped = ['read_file', 'validate', 'replace_in_file', 'write_file'].map(tool);
    expect(isGateSurgicalEditTurn(gateNudge, clamped)).toBe(true);
  });
});

describe('constrained-turn reasoning allowance', () => {
  it('gives Muse Glimmer the expanded allowance — its template has no no-think mode, so even reasoning_strength=low overruns the strict budget on whole-file deliverables', () => {
    expect(constrainedToolReasoningCharLimitForModel('muse-glimmer-30b-q4')).toBe(3072);
    expect(constrainedToolNoSignalMsForModel('muse-glimmer-30b-q4')).toBe(90_000);
    // Sibling quants inherit it.
    expect(constrainedToolReasoningCharLimitForModel('muse-glimmer-30b-dynamic')).toBe(3072);
    // Models that honor no-think keep the tight guard.
    expect(constrainedToolReasoningCharLimitForModel('qwen3.6-27b-q4')).toBe(1024);
  });
});

describe('LlamaCppProvider — waiting for a physical engine slot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces the wait instead of parking silently', async () => {
    vi.useFakeTimers();
    // One physical slot, the shape a supervised single-slot launch has.
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', concurrency: 1 });
    const held = await provider.acquireExclusiveEngineRequest('first');

    const seen: number[] = [];
    const pending = provider.acquireExclusiveEngineRequest('second', undefined, ({ aheadOf }) =>
      seen.push(aheadOf),
    );

    // A brief wait (a background one-shot between iterations) stays quiet.
    await vi.advanceTimersByTimeAsync(150);
    expect(seen).toEqual([]);

    // Past the threshold the turn says so, and keeps saying so. Before this,
    // a turn could sit here for the whole of another session's round-trip —
    // minutes on one slot — with nothing but a debug line to show for it,
    // which the silence banner read as a wedged model.
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(seen.length).toBeGreaterThanOrEqual(3);

    held();
    const release = await pending;
    const atAcquire = seen.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(seen).toHaveLength(atAcquire);
    release();
  });

  it('does not announce anything when a slot is free', async () => {
    vi.useFakeTimers();
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', concurrency: 1 });
    const seen: number[] = [];
    const release = await provider.acquireExclusiveEngineRequest('only', undefined, ({ aheadOf }) =>
      seen.push(aheadOf),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toEqual([]);
    release();
  });
});
