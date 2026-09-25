import {
  MobileInferenceBudgetSchema,
  type MobileProviderId,
  MobileProviderIdSchema,
} from '../schemas/mobile-provider.js';
import { acquireSuspendMonitor, createAwakeTimeout } from '../suspend-clock.js';
import {
  type RewriteOpts,
  type TransformHooks,
  type TransformOpts,
  buildRewritePrompt,
  buildTransformPrompt,
  cleanTransformOutput,
  createThinkSplitter,
  oneShotSystemMessage,
} from '../transform/index.js';
import { encodeText } from './files.js';
import { portableInputLimitError } from './inference-limits.js';
import type { PortableInference } from './product-service.js';

export interface PortableTransformTarget {
  gezelId: string;
  about: string;
  providerId: MobileProviderId;
  modelId: string;
  contextSize: number;
  maxTokens: number;
}

export interface PortableTransformOptions {
  /** Resolve the configured Klerk, recruiting a canonical one only if needed.
   * The service owns foreground admission and holds it until this runner ends. */
  resolveKlerk(signal: AbortSignal): Promise<PortableTransformTarget>;
  signal?: AbortSignal;
  timeoutMs?: number;
  requestId?: string;
  hooks?: TransformHooks;
}

export function portableTransformText(
  inference: PortableInference,
  opts: TransformOpts,
  options: PortableTransformOptions,
): Promise<string> {
  return complete(inference, buildTransformPrompt(opts), options);
}

export function portableRewriteText(
  inference: PortableInference,
  opts: RewriteOpts,
  options: PortableTransformOptions,
): Promise<string> {
  return complete(inference, buildRewritePrompt(opts), options);
}

function stopped(message = 'Text transform stopped', name = 'AbortError'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** No chat history, tools, persisted session, or alternate model is introduced.
 * Native cancellation is a release barrier; failed cancellation keeps admission
 * held until the generation itself settles. Partial output is preview only. */
async function complete(
  inference: PortableInference,
  prompt: string,
  options: PortableTransformOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error('Text transform timeout must be between 1 and 120000 milliseconds');
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason ?? stopped());
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const releaseMonitor = acquireSuspendMonitor();
  const timeout = createAwakeTimeout(timeoutMs, {
    reason: (budget) =>
      stopped(`Text transform timed out${budget.describeSuspension()}`, 'TimeoutError'),
  });
  const expire = () => controller.abort(timeout.signal.reason);
  timeout.signal.addEventListener('abort', expire, { once: true });
  const reason = () =>
    controller.signal.reason instanceof Error ? controller.signal.reason : stopped();
  const check = () => {
    if (controller.signal.aborted) throw reason();
  };
  const requestId = options.requestId ?? crypto.randomUUID();
  let generation: ReturnType<PortableInference['generate']> | undefined;
  let cancellation: Promise<void> | undefined;
  let settled = false;
  let rejectAbort: (reason: Error) => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const cancelNative = () => {
    if (!generation || settled || cancellation) return;
    cancellation = Promise.resolve().then(() => inference.cancel(requestId));
    void cancellation.then(
      () => rejectAbort(reason()),
      async () => {
        // A failed cancellation is not proof that the engine has released.
        await generation?.catch(() => {});
        rejectAbort(reason());
      },
    );
  };
  controller.signal.addEventListener('abort', cancelNative);
  try {
    check();
    const target = await options.resolveKlerk(controller.signal);
    check();
    if (!target.gezelId || !target.modelId)
      throw new Error('Choose an available model for the Klerk in Settings');
    const providerId = MobileProviderIdSchema.parse(target.providerId);
    const budget = MobileInferenceBudgetSchema.parse({
      contextSize: target.contextSize,
      maxTokens: target.maxTokens,
    });
    const messages = [
      { role: 'system' as const, content: oneShotSystemMessage(target.about.trim() || undefined) },
      { role: 'user' as const, content: prompt },
    ];
    const inputError = portableInputLimitError(messages);
    if (inputError) throw new Error(inputError);
    let outputBytes = 0;
    const splitter = createThinkSplitter({
      onThinking: (text) => options.hooks?.onThinking?.(text),
      onOutput: (text) => options.hooks?.onOutput?.(text),
    });
    generation = Promise.resolve().then(() => {
      check();
      return inference.generate(
        { requestId, providerId, modelId: target.modelId, ...budget, messages },
        (event) => {
          if (controller.signal.aborted || settled || event.requestId !== requestId) return;
          outputBytes += encodeText(event.delta).byteLength;
          if (outputBytes > 256 * 1024) {
            controller.abort(new Error('Text transform exceeded the supported output size'));
            return;
          }
          try {
            splitter.push(event.delta);
          } catch (error) {
            controller.abort(error);
          }
        },
      );
    });
    const result = await Promise.race([generation, cancelled]);
    settled = true;
    check();
    if (result.stopReason === 'cancelled') throw stopped();
    if (result.stopReason === 'length')
      throw new Error(
        'The model reached its reply limit. Try a shorter selection or a larger reply budget.',
      );
    if (encodeText(result.text).byteLength > 256 * 1024)
      throw new Error('Text transform exceeded the supported output size');
    splitter.flush();
    return cleanTransformOutput(result.text);
  } finally {
    timeout.signal.removeEventListener('abort', expire);
    timeout.dispose();
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancelNative);
    // Do not let a generation/abort race release the service's busy state early.
    await cancellation?.catch(() => {});
    releaseMonitor();
  }
}
