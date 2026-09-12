import { GezelSdkError, errorFromResponse } from './errors.js';
import { readSseDataChunks } from './sse.js';
import type {
  AppToolDefinition,
  AppToolHandlerResult,
  AppToolsRegistration,
  AuthorizedConnection,
  RegisterAppToolsInput,
} from './types.js';

/**
 * Register tools your application runs itself.
 *
 * The model sees them exactly like Gezel's own tools. When one is called, the
 * daemon sends the call here, this SDK runs your handler, and the handler's
 * return value becomes the tool's output. Nothing of yours runs inside the
 * daemon — only the arguments and the result cross the wire.
 *
 * Registration lives as long as the returned handle. Close it, or exit, and
 * the tools are withdrawn: a tool whose handler is gone would accept a call
 * and never answer, which is worse for the model than no tool at all.
 *
 * Needs a connection with the `product` scope (or a daemon this app hosts).
 */
export async function registerAppTools(
  connection: Pick<AuthorizedConnection, 'baseUrl' | 'token' | 'fetch'>,
  input: RegisterAppToolsInput,
): Promise<AppToolsRegistration> {
  const fetchImpl = connection.fetch ?? globalThis.fetch;
  const api = async (method: string, path: string, body?: unknown): Promise<Response> =>
    fetchImpl(`${connection.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  let tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  let closed = false;
  let relayId = '';
  let readyResolve: (() => void) | undefined;
  let readyReject: ((err: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let aborter = new AbortController();
  // Held so `close()` can end the read loop directly. Aborting the request
  // signal is not enough on its own: the read parks until the socket notices,
  // and cancelling the response body fails because the reader holds its lock.
  // Cancelling the reader we own is what actually unparks it.
  let cancelActive: (() => Promise<void>) | undefined;

  const openRelay = async (): Promise<string> => {
    const res = await api('POST', '/api/app-tools/relays', {
      ...(input.label ? { label: input.label } : {}),
    });
    if (!res.ok) throw await errorFromResponse(res);
    const body = (await res.json()) as { relayId: string };
    return body.relayId;
  };

  const publishTools = async (id: string): Promise<void> => {
    const res = await api('PUT', `/api/app-tools/relays/${encodeURIComponent(id)}/tools`, {
      projectId: input.projectId,
      ...(input.gezelIds ? { gezelIds: input.gezelIds } : {}),
      tools: [...tools.values()].map(({ name, description, inputSchema, timeoutMs }) => ({
        name,
        description,
        inputSchema,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })),
    });
    if (!res.ok) throw await errorFromResponse(res);
  };

  const runCall = async (
    id: string,
    call: {
      callId: string;
      tool: string;
      arguments: Record<string, unknown>;
      timeoutMs: number;
      sessionId: string;
      gezelId: string;
      projectId: string;
    },
  ): Promise<void> => {
    const handler = tools.get(call.tool)?.handler;
    let result: { ok: true; content: unknown } | { ok: false; error: string };
    if (!handler) {
      result = { ok: false, error: `this app no longer offers "${call.tool}"` };
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), call.timeoutMs);
      try {
        const output = await handler(call.arguments, {
          callId: call.callId,
          sessionId: call.sessionId,
          gezelId: call.gezelId,
          projectId: call.projectId,
          signal: controller.signal,
        });
        result = { ok: true, content: normalizeResult(output) };
      } catch (err) {
        // A handler that throws is an ordinary tool failure: the model is
        // told, and the turn carries on.
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        input.onError?.(err);
      } finally {
        clearTimeout(timer);
      }
    }
    const res = await api(
      'POST',
      `/api/app-tools/relays/${encodeURIComponent(id)}/calls/${encodeURIComponent(call.callId)}/result`,
      result.ok ? { ok: true, content: result.content } : result,
    );
    // A 404 means the daemon gave up waiting; nothing left to do but note it.
    if (!res.ok && res.status !== 404) input.onError?.(await errorFromResponse(res));
    await res.body?.cancel();
  };

  /**
   * Hold the relay's event stream, reconnecting until closed. A dropped socket
   * is ordinary (sleep, a network blip); the daemon keeps the registration for
   * a short grace window, and a relay that is gone by the time we return is
   * simply opened again.
   */
  const pump = async (): Promise<void> => {
    let backoff = 500;
    while (!closed) {
      try {
        if (!relayId) {
          relayId = await openRelay();
          await publishTools(relayId);
        }
        aborter = new AbortController();
        const res = await fetchImpl(
          `${connection.baseUrl}/api/app-tools/relays/${encodeURIComponent(relayId)}/events`,
          {
            headers: { Authorization: `Bearer ${connection.token}` },
            signal: aborter.signal,
          },
        );
        if (res.status === 404) {
          relayId = '';
          continue;
        }
        if (!res.ok || !res.body) throw await errorFromResponse(res);

        input.onStatus?.('connected');
        readyResolve?.();
        backoff = 500;
        const reader = res.body.getReader();
        cancelActive = async () => void (await reader.cancel().catch(() => undefined));
        for await (const chunk of readSseDataChunks(streamFromReader(reader))) {
          if (!chunk) continue;
          const event = JSON.parse(chunk) as { type: string } & Record<string, unknown>;
          if (event.type === 'tool_call') {
            void runCall(relayId, event as never);
          } else if (event.type === 'closed') {
            relayId = '';
            break;
          }
        }
      } catch (err) {
        cancelActive = undefined;
        if (closed) break;
        if (err instanceof GezelSdkError && err.status === 401) {
          readyReject?.(err);
          input.onStatus?.('closed');
          input.onError?.(err);
          return;
        }
        input.onError?.(err);
      }
      if (closed) break;
      input.onStatus?.('reconnecting');
      await sleep(backoff + Math.random() * 250);
      backoff = Math.min(backoff * 2, 8_000);
    }
    input.onStatus?.('closed');
  };

  const pumping = pump();
  // Surface an immediate failure (bad token, no such project) to the caller
  // rather than making them discover it through a silent absence of tools.
  await Promise.race([ready, pumping]);

  return {
    get relayId() {
      return relayId;
    },
    ready,
    async update(next: AppToolDefinition[]) {
      tools = new Map(next.map((tool) => [tool.name, tool]));
      if (relayId) await publishTools(relayId);
    },
    async close() {
      closed = true;
      aborter.abort();
      await cancelActive?.();
      if (relayId) {
        await api('DELETE', `/api/app-tools/relays/${encodeURIComponent(relayId)}`)
          .then((res) => res.body?.cancel())
          .catch(() => undefined);
      }
      await pumping.catch(() => undefined);
    },
  };
}

/**
 * Re-wrap a reader we hold as a stream the SSE parser can consume. The parser
 * takes a stream and would otherwise own the reader — and then nothing outside
 * the read loop could stop it.
 */
function streamFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** Accept the shapes a handler naturally returns. */
function normalizeResult(output: AppToolHandlerResult): unknown {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && 'content' in output) return output.content;
  return JSON.stringify(output);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
