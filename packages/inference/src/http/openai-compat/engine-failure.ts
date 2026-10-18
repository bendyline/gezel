/**
 * The OpenAI-compatible routes' vocabulary for an on-device engine failure.
 *
 * Providers already throw typed errors that say exactly what went wrong: the
 * capacity broker refused the model's memory, the engine crashed, the prompt
 * overflowed its context. These routes kept only the message and stamped every
 * one `provider_error`, so a connected app could not tell "this machine cannot
 * fit the model" from "try again in a second" without parsing prose — and the
 * prose is exactly what a sanitizing proxy strips. Each internal code maps to
 * one stable wire code here; anything unrecognized stays `provider_error`.
 */

export type EngineFailureCode =
  | 'capacity_denied'
  | 'engine_busy'
  | 'engine_launch_failed'
  | 'engine_crashed'
  | 'engine_out_of_memory'
  | 'context_length_exceeded'
  | 'engine_not_ready'
  | 'model_not_ready';

export interface EngineFailure {
  code: EngineFailureCode | 'provider_error';
  type: 'server_error' | 'invalid_request_error';
  status: 400 | 500;
}

/** Internal error `code` (as thrown) → wire code (as sent). */
const WIRE_CODES: ReadonlyMap<string, EngineFailureCode> = new Map([
  ['capacity-denied', 'capacity_denied'],
  ['engine-busy', 'engine_busy'],
  ['engine-launch', 'engine_launch_failed'],
  ['native-engine-crash', 'engine_crashed'],
  ['context-overflow', 'context_length_exceeded'],
  ['engine-not-ready', 'engine_not_ready'],
  ['model-not-ready', 'model_not_ready'],
]);

/**
 * Stand-ins for an engine failure's own message wherever a response body must
 * not carry internal detail (the service's opaque-error middleware). The
 * provider's message can name binaries and model paths.
 */
export const ENGINE_FAILURE_SUMMARIES: Readonly<Record<EngineFailureCode, string>> = {
  capacity_denied: 'This machine does not have enough free memory to run this model right now.',
  engine_busy: 'The on-device engine is busy with another request. Try again shortly.',
  engine_launch_failed: 'The on-device engine could not be started on this machine.',
  engine_crashed: 'The on-device engine stopped unexpectedly. Try again.',
  engine_out_of_memory:
    'This computer ran out of memory and the on-device engine was stopped. Close other programs or use a smaller model, then try again.',
  context_length_exceeded: 'The prompt is longer than this model can read at once.',
  engine_not_ready: 'The on-device engine is still getting ready. Try again shortly.',
  model_not_ready: 'This model is not ready yet.',
};

export function isEngineFailureCode(value: unknown): value is EngineFailureCode {
  return typeof value === 'string' && Object.hasOwn(ENGINE_FAILURE_SUMMARIES, value);
}

const MAX_CAUSE_DEPTH = 5;

/**
 * The outermost recognized code wins: a wrapper such as
 * `NativeEngineCrashedError` is the provider's own classification of the
 * cause it carries.
 */
function internalCode(err: unknown): EngineFailureCode | undefined {
  const seen = new Set<unknown>();
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== 'object' || seen.has(current)) return undefined;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    const wire = typeof code === 'string' ? WIRE_CODES.get(code) : undefined;
    // A crash the out-of-memory killer caused is a capacity fact, not a fault.
    if (
      wire === 'engine_crashed' &&
      (current as { panicKind?: unknown }).panicKind === 'host-out-of-memory'
    ) {
      return 'engine_out_of_memory';
    }
    if (wire) return wire;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function engineFailure(err: unknown): EngineFailure {
  const code = internalCode(err);
  if (!code) return { code: 'provider_error', type: 'server_error', status: 500 };
  // OpenAI's own spelling and status for an over-long prompt. A 500 makes
  // every SDK retry a request that cannot fit no matter how often it is sent.
  if (code === 'context_length_exceeded') {
    return { code, type: 'invalid_request_error', status: 400 };
  }
  return { code, type: 'server_error', status: 500 };
}
