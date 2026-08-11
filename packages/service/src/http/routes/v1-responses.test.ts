import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../../providers/mock.js';
import { type RunningService, startService } from '../../service.js';

let service: RunningService;
let baseUrl: string;
let rootToken: string;
let home: string;
let httpFetch: typeof fetch;
let mockCopilot: MockProvider;
let codexToken: string;
let productOnlyToken: string;

const previousMockProvider = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-responses-'));
  service = await startService({ home });
  baseUrl = `${service.cert ? 'https' : 'http'}://127.0.0.1:${service.port}`;
  rootToken = service.context.token;
  httpFetch = service.cert ? createTrustingFetch({ cert: service.cert.certPem }) : fetch;

  const provider = await service.context.chat.getProvider('copilot');
  if (!(provider instanceof MockProvider)) throw new Error('expected MockProvider in test env');
  mockCopilot = provider;
  codexToken = (
    await service.context.tokenStore.issue({
      appId: 'codex-responses-test',
      appName: 'Codex Responses test',
      scopes: ['openai'],
    })
  ).token;
  productOnlyToken = (
    await service.context.tokenStore.issue({
      appId: 'product-only-responses-test',
      appName: 'Product-only Responses test',
      scopes: ['product'],
    })
  ).token;
}, 30_000);

afterAll(async () => {
  await service.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (previousMockProvider === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = previousMockProvider;
}, 30_000);

function postResponses(body: unknown, token?: string): Promise<Response> {
  return httpFetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const EXEC_TOOL = {
  type: 'function' as const,
  name: 'exec_command',
  description: 'Run a command.',
  strict: false,
  parameters: {
    type: 'object',
    properties: { cmd: { type: 'string' } },
    required: ['cmd'],
    additionalProperties: false,
  },
};

describe('POST /v1/responses — Codex facade', () => {
  it('requires an OpenAI-scoped bearer token', async () => {
    const response = await postResponses({ model: 'copilot:mock-fast', input: 'hi' });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_api_key', type: 'invalid_request_error' },
    });

    const wrongScope = await postResponses(
      { model: 'copilot:mock-fast', input: 'hi' },
      productOnlyToken,
    );
    expect(wrongScope.status).toBe(403);
    await expect(wrongScope.json()).resolves.toMatchObject({
      error: { code: 'missing_scope:openai', type: 'permission_error' },
    });
  });

  it('accepts the current Codex streaming request shape', async () => {
    const response = await postResponses(
      {
        model: 'copilot:mock-fast',
        instructions: 'Be concise.',
        input: [
          {
            type: 'message',
            id: 'msg_user_1',
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply only with ok.' }],
          },
        ],
        tools: [
          EXEC_TOOL,
          {
            type: 'namespace',
            name: 'team',
            description: 'Team operations.',
            tools: [
              {
                type: 'function',
                name: 'delegate',
                description: 'Delegate work.',
                strict: false,
                parameters: {
                  type: 'object',
                  properties: { task: { type: 'string' } },
                  required: ['task'],
                },
              },
            ],
          },
        ],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { summary: 'auto' },
        store: false,
        stream: true,
        service_tier: 'priority',
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'codex-thread-1',
        client_metadata: { thread_id: 'codex-thread-1' },
      },
      codexToken,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = parseSse(await response.text());
    expect(events[0]?.type).toBe('response.created');
    expect(events.some((event) => event.type === 'response.output_text.delta')).toBe(true);
    expect(events.some((event) => event.type === 'response.output_item.done')).toBe(true);
    expect(events.at(-1)?.type).toBe('response.completed');
    const completed = events.find((event) => event.type === 'response.completed') as
      | { response?: Record<string, unknown> }
      | undefined;
    expect(completed?.response).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'copilot:mock-fast',
      store: false,
    });
    expect(completed?.response?.usage).toMatchObject({
      input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
  });

  it('returns a complete non-streaming Responses envelope', async () => {
    const response = await postResponses(
      {
        model: 'copilot:mock-fast',
        instructions: 'Keep it short.',
        input: 'What is 2+2?',
        store: false,
      },
      rootToken,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      status: string;
      model: string;
      output_text: string;
      output: Array<{ type: string; role?: string }>;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.model).toBe('copilot:mock-fast');
    expect(body.output_text).toContain('What is 2+2?');
    expect(body.output).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message', role: 'assistant' })]),
    );
    expect(body.usage.total_tokens).toBe(body.usage.input_tokens + body.usage.output_tokens);
  });

  it('resolves a stable gezel id and layers its persona ahead of Codex instructions', async () => {
    const summary = (await service.context.store.listGezels()).find(
      (gezel) => !gezel.fixedFunction,
    );
    expect(summary).toBeDefined();
    const gezel = await service.context.store.getGezel(summary!.id);
    expect(gezel?.about.trim()).toBeTruthy();
    const callsBefore = mockCopilot.calls.length;

    const response = await postResponses(
      {
        model: `gezel:${summary!.id}`,
        instructions: 'Codex keeps ownership of the coding loop.',
        input: 'Introduce yourself briefly.',
        store: false,
      },
      rootToken,
    );

    expect(response.status).toBe(200);
    const create = mockCopilot.calls.slice(callsBefore).find((call) => call.kind === 'create');
    const systemMessage = create?.opts?.systemMessage ?? '';
    expect(systemMessage).toContain(gezel!.about.trim());
    expect(systemMessage).toContain('Codex keeps ownership of the coding loop.');
    expect(systemMessage.indexOf(gezel!.about.trim())).toBeLessThan(
      systemMessage.indexOf('Codex keeps ownership of the coding loop.'),
    );
  });

  it('aborts in-flight provider work when a streaming Codex client disconnects', async () => {
    const callsBefore = mockCopilot.calls.length;
    mockCopilot.scriptStreamThenHang('partial');
    const abortController = new AbortController();
    const response = await httpFetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${codexToken}`,
      },
      body: JSON.stringify({
        model: 'copilot:mock-fast',
        input: 'keep generating',
        stream: true,
        store: false,
      }),
      signal: abortController.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader!.read();
    abortController.abort();
    await reader!.cancel().catch(() => {});

    await waitUntil(() =>
      mockCopilot.calls.slice(callsBefore).some((call) => call.kind === 'disconnect'),
    );
    const send = mockCopilot.calls.slice(callsBefore).find((call) => call.kind === 'send');
    expect(send?.sendOpts?.queue?.signal?.aborted).toBe(true);
  });

  it('round-trips a function call and its output as stateless history', async () => {
    mockCopilot.scriptExternalToolCalls([
      { id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    ]);
    const first = await postResponses(
      {
        model: 'copilot:mock-fast',
        input: 'Run pwd.',
        tools: [EXEC_TOOL],
        store: false,
      },
      rootToken,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      output: Array<Record<string, unknown>>;
    };
    expect(firstBody.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
        }),
      ]),
    );

    const second = await postResponses(
      {
        model: 'copilot:mock-fast',
        input: [
          { type: 'message', role: 'user', content: 'Run pwd.' },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
          },
          { type: 'function_call_output', call_id: 'call_1', output: '/workspace' },
        ],
        tools: [EXEC_TOOL],
        store: false,
      },
      rootToken,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { output_text: string };
    expect(secondBody.output_text).toBeTruthy();
  });

  it('returns OpenAI validation envelopes for malformed requests', async () => {
    const response = await postResponses({ model: '', input: [] }, rootToken);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_body', type: 'invalid_request_error' },
    });
  });

  it('does not silently pretend to support stored response state', async () => {
    const response = await postResponses(
      {
        model: 'copilot:mock-fast',
        input: 'hi',
        previous_response_id: 'resp_old',
      },
      rootToken,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'stored_state_not_supported' },
    });
  });

  it('does not route an unknown Codex model alias through the fallback gezel', async () => {
    const response = await postResponses(
      { model: 'mistyped-local-alias', input: 'hi', store: false },
      codexToken,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'model_not_found' },
    });
  });

  it('refuses to nest a native coding-agent provider behind inference auth', async () => {
    const response = await postResponses(
      { model: 'codex-cli:gpt-5.4', input: 'edit the repository', store: false },
      codexToken,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'provider_not_inference_only' },
    });
  });

  it('rejects provider-hosted web search with actionable Codex configuration', async () => {
    const response = await postResponses(
      {
        model: 'copilot:mock-fast',
        input: 'search the web',
        tools: [{ type: 'web_search' }],
        store: false,
      },
      codexToken,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'unsupported_tool',
        message: expect.stringContaining('web_search = "disabled"'),
      },
    });
  });
});
