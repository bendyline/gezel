import {
  RewriteTextRequestSchema,
  type TransformStreamEvent,
  TransformTextRequestSchema,
} from '../schemas/api.js';
import type { PortableInference } from './product-service.js';
import {
  type PortableTransformOptions,
  portableRewriteText,
  portableTransformText,
} from './transform.js';

export interface PortableTextOperation {
  controller: AbortController;
  finished: Promise<string>;
  response: Promise<Response>;
}

/** Ordinary client JSON/SSE contracts; results stay in the editor until the user applies them. */
export function createPortableTextOperation(
  inference: PortableInference,
  kind: 'rewrite' | 'transform',
  raw: unknown,
  signal: AbortSignal,
  resolveKlerk: PortableTransformOptions['resolveKlerk'],
): PortableTextOperation {
  const body =
    kind === 'rewrite'
      ? RewriteTextRequestSchema.parse(raw)
      : TransformTextRequestSchema.parse(raw);
  if (kind === 'transform') {
    if ('mode' in body && body.mode === 'insert' && !body.instruction?.trim())
      throw new Error('insert mode requires an instruction');
    if ('mode' in body && body.mode === 'rewrite' && !body.text.trim())
      throw new Error('empty text');
  } else if (
    !body.text.trim() &&
    !body.instruction?.trim() &&
    !(body.context === 'task-description' && body.subject?.trim())
  )
    throw new Error('empty text');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const emit = (event: TransformStreamEvent) => {
    if (!closed) streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const stream =
    kind === 'transform'
      ? new ReadableStream<Uint8Array>({
          start(value) {
            streamController = value;
          },
          cancel() {
            closed = true;
            controller.abort();
          },
        })
      : undefined;
  const finished = Promise.resolve()
    .then(async () => {
      emit({ type: 'status', phase: 'started' });
      const options: PortableTransformOptions = {
        resolveKlerk,
        signal: controller.signal,
        hooks: {
          onThinking: (text) => emit({ type: 'thinking-delta', text }),
          onOutput: (text) => emit({ type: 'output-delta', text }),
        },
      };
      const text =
        kind === 'rewrite'
          ? await portableRewriteText(inference, RewriteTextRequestSchema.parse(body), options)
          : await portableTransformText(inference, TransformTextRequestSchema.parse(body), options);
      if (!text) throw new Error(`${kind} returned empty content`);
      return text;
    })
    .finally(() => signal.removeEventListener('abort', abort));
  const response = stream
    ? Promise.resolve(
        new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        }),
      )
    : finished.then(
        (text) =>
          new Response(JSON.stringify({ text }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
  // Observe both outcomes even when a client cancels its reader before completion.
  void finished
    .then(
      (text) => emit({ type: 'done', text }),
      (error) =>
        emit({ type: 'error', error: error instanceof Error ? error.message : String(error) }),
    )
    .finally(() => {
      if (!closed) {
        closed = true;
        streamController?.close();
      }
    });
  return { controller, finished, response };
}
