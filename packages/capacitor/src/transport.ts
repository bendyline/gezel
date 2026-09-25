import {
  GezelApp,
  GezelSdkError,
  type PortableChatCompletionResponse,
} from '@bendyline/gezel-app-sdk/browser';
import { type PortableInference, createNativeInference } from '@bendyline/gezel/mobile-inference';
import { prepareChat } from './chat.js';
import type { GezelRuntimePlugin } from './definitions.js';
import { listModels, requireModel } from './models.js';

const origin = 'https://gezel.native.invalid';
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const abortError = () => new DOMException('The operation was aborted', 'AbortError');
const errorOf = (error: unknown) =>
  error instanceof GezelSdkError || (error instanceof Error && error.name === 'AbortError')
    ? error
    : new GezelSdkError(
        typeof error === 'object' && error && 'message' in error
          ? String(error.message)
          : 'Native operation failed',
        {
          code:
            typeof error === 'object' && error && 'code' in error
              ? String(error.code)
              : 'native_error',
        },
      );

/** In-process Fetch transport. No HTTP listener, network fallback, or product service. */
export function connectRuntime(plugin: GezelRuntimePlugin): GezelApp<'portable'> {
  const inference = createNativeInference(plugin);
  const token = crypto.randomUUID();
  const runs = new Map<string, { stop(): Promise<void>; done: Promise<void> }>();
  let closed = false;
  const assertOpen = (signal?: AbortSignal | null) => {
    if (signal?.aborted) throw abortError();
    if (closed) throw new GezelSdkError('This Gezel client is closed', { code: 'closed' });
  };

  const dispatch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assertOpen(request.signal);
    const url = new URL(request.url);
    if (url.origin !== origin || request.headers.get('authorization') !== `Bearer ${token}`) {
      throw new GezelSdkError('Unknown native connection', { code: 'unauthorized' });
    }
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      const result = await listModels(inference);
      assertOpen(request.signal);
      return jsonResponse(result);
    }
    if (url.pathname === '/v1/models/ensure' && request.method === 'POST') {
      const input = (await request.json()) as { model?: unknown };
      if (typeof input.model !== 'string')
        throw new GezelSdkError('A model is required', { code: 'invalid_request' });
      // Model preparation is explicit via the native management API. Inspection
      // never authorizes a download or silently substitutes another provider.
      await requireModel(inference, input.model);
      assertOpen(request.signal);
      return jsonResponse({ status: 'ready', model_id: input.model });
    }
    if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') {
      throw new GezelSdkError('This operation is unavailable in the on-device text runtime', {
        code: 'unsupported_capability',
      });
    }
    const prepared = await prepareChat(inference, await request.json());
    assertOpen(request.signal);
    return runChat(inference, prepared, request.signal, runs);
  };

  const fetchNative: typeof fetch = async (input, init) => {
    try {
      return await dispatch(input, init);
    } catch (error) {
      throw errorOf(error);
    }
  };

  return new GezelApp({
    baseUrl: origin,
    token,
    fetch: fetchNative,
    responseFormat: 'portable',
    close: async () => {
      closed = true;
      // This client owns its requests, not other clients' shared native runtime.
      await Promise.all(
        [...runs.values()].map(async (run) => {
          await run.stop();
          await run.done;
        }),
      );
    },
  });
}

async function runChat(
  inference: PortableInference,
  prepared: Awaited<ReturnType<typeof prepareChat>>,
  signal: AbortSignal,
  runs: Map<string, { stop(): Promise<void>; done: Promise<void> }>,
): Promise<Response> {
  const id = crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const model = prepared.request.model;
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stopped = false;
  let settled = false;
  let emitted = '';
  let terminalError: Error | undefined;
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = async () => {
    stopped = true;
    if (!settled) streamController?.error(terminalError ?? abortError());
    try {
      await inference.cancel(id);
    } catch (error) {
      terminalError ??= errorOf(error);
    }
    await done;
  };
  const onAbort = () => {
    terminalError = abortError();
    if (!settled) streamController?.error(terminalError);
    void stop();
  };
  const frame = (data: unknown) => {
    if (!stopped && streamController)
      streamController.enqueue(
        encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`),
      );
  };
  const chunk = (content?: string, finish_reason: string | null = null) =>
    frame({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: content === undefined ? {} : { role: 'assistant', content },
          finish_reason,
        },
      ],
    });
  const stream = prepared.request.stream
    ? new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller;
          },
          async cancel() {
            await stop();
          },
        },
        { highWaterMark: 1024 * 1024, size: (bytes) => bytes.byteLength },
      )
    : undefined;
  runs.set(id, { stop, done });
  signal.addEventListener('abort', onAbort, { once: true });
  // generate reserves the shared admission gate synchronously, before cancel.
  const generation = inference.generate({ requestId: id, ...prepared.native }, ({ delta }) => {
    if (stopped) return;
    emitted += delta;
    if (emitted.length > 4 * 1024 * 1024 || (streamController?.desiredSize ?? 1) <= 0) {
      terminalError = new GezelSdkError('Native response exceeded the consumer buffer', {
        code: 'resource_limit',
      });
      streamController?.error(terminalError);
      void stop();
      return;
    }
    chunk(delta);
  });
  if (signal.aborted) onAbort();
  const result = generation
    .then((reply) => {
      if (terminalError) throw terminalError;
      if (stopped) throw abortError();
      if (
        typeof reply?.text !== 'string' ||
        !['stop', 'length', 'cancelled'].includes(reply.stopReason)
      )
        throw new GezelSdkError('Invalid native completion', { code: 'native_protocol' });
      if (reply.text.length > 4 * 1024 * 1024)
        throw new GezelSdkError('Native response exceeded the consumer buffer', {
          code: 'resource_limit',
        });
      if (!reply.text.startsWith(emitted))
        throw new GezelSdkError('Native stream and final text disagree', {
          code: 'native_protocol',
        });
      if (reply.text.length > emitted.length) chunk(reply.text.slice(emitted.length));
      chunk(undefined, reply.stopReason);
      frame('[DONE]');
      streamController?.close();
      const completion: PortableChatCompletionResponse = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply.text },
            finish_reason: reply.stopReason,
          },
        ],
      };
      return jsonResponse(completion);
    })
    .catch((error: unknown) => {
      const failure = terminalError ?? errorOf(error);
      if (!stopped) streamController?.error(failure);
      if (!stream) throw failure;
      return new Response(null);
    })
    .finally(() => {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      runs.delete(id);
      release();
    });
  return stream
    ? new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    : result;
}
