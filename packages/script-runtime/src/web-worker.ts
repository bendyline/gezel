import { acquireSuspendMonitor, createAwakeTimeout } from '@bendyline/gezel';
import type { ScriptExecutionOptions, ScriptExecutionResult, ScriptExecutor } from './index.js';
import {
  QUICKJS_MAX_CALLS,
  QUICKJS_MAX_MESSAGE_CHARS,
  QUICKJS_MAX_PENDING_CALLS,
  QUICKJS_MAX_TOTAL_MESSAGE_CHARS,
  QUICKJS_START_TIMEOUT_MS,
  type QuickJSHostReply,
  type QuickJSWorkerData,
  type QuickJSWorkerMessage,
} from './worker-protocol.js';

/** Dedicated workers provide a second, host-owned deadline outside the guest's VM. */
export class WebWorkerScriptExecutor implements ScriptExecutor {
  constructor(private readonly createWorker: () => Worker) {}

  async execute(options: ScriptExecutionOptions): Promise<ScriptExecutionResult> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
      throw new Error('Invalid script timeout');
    if (options.source.length > QUICKJS_MAX_MESSAGE_CHARS)
      throw new Error('Script source is too large');
    const failed = (stderr: string, timedOut = false): ScriptExecutionResult => ({
      exitCode: 1,
      stdout: '',
      stderr,
      timedOut,
    });
    if (options.signal?.aborted) return failed('Error: script execution cancelled');
    const worker = this.createWorker();
    const releaseMonitor = acquireSuspendMonitor();
    try {
      return await new Promise<ScriptExecutionResult>((resolve) => {
        let active = true;
        let calls = 0;
        let total = 0;
        const pending = new Set<number>();
        const seen = new Set<number>();
        const finish = (result: ScriptExecutionResult) => {
          if (!active) return;
          active = false;
          timeout.dispose();
          timeout.signal.removeEventListener('abort', onTimeout);
          options.signal?.removeEventListener('abort', onAbort);
          started();
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          resolve(result);
        };
        const stop = (message: string, timedOut = false) => {
          if (!active) return;
          try {
            options.onStderr(message);
          } finally {
            finish(failed(message, timedOut));
          }
        };
        const onAbort = () => stop('Error: script execution cancelled');
        // A worker killed before it runs reports nothing at all.
        let startup: ReturnType<typeof setTimeout> | undefined = setTimeout(
          () => stop('Error: the script worker did not start'),
          QUICKJS_START_TIMEOUT_MS,
        );
        const started = () => {
          if (startup === undefined) return;
          clearTimeout(startup);
          startup = undefined;
        };
        const timeout = createAwakeTimeout(options.timeoutMs);
        const onTimeout = () =>
          stop(`Error: script execution timed out${timeout.budget.describeSuspension()}`, true);
        timeout.signal.addEventListener('abort', onTimeout, { once: true });
        const account = (json: string) => {
          total += json.length;
          if (json.length > QUICKJS_MAX_MESSAGE_CHARS || total > QUICKJS_MAX_TOTAL_MESSAGE_CHARS)
            throw new Error('Script message size limit exceeded');
        };
        const reply = (frame: QuickJSHostReply) => {
          if (!active) return;
          try {
            const json = JSON.stringify(frame);
            account(json);
            worker.postMessage(json);
          } catch (error) {
            stop(message(error));
          }
        };
        const request = async (frame: Extract<QuickJSWorkerMessage, { kind: 'request' }>) => {
          try {
            if (!active || options.signal?.aborted || timeout.budget.expired())
              throw new Error('Script execution has ended');
            const result = await options.onRequest(frame.method, frame.params);
            reply({ runId: options.init.runId, id: frame.id, result });
          } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;
            reply({
              runId: options.init.runId,
              id: frame.id,
              error: { message: message(error), ...(typeof code === 'string' ? { code } : {}) },
            });
          } finally {
            pending.delete(frame.id);
          }
        };
        worker.onmessage = (event: MessageEvent<unknown>) => {
          if (!active) return;
          try {
            if (timeout.budget.expired()) {
              stop('Error: script execution timed out', true);
              return;
            }
            if (typeof event.data !== 'string') throw new Error('Invalid script worker message');
            account(event.data);
            const frame = JSON.parse(event.data) as QuickJSWorkerMessage;
            if (frame.runId !== options.init.runId) throw new Error('Invalid script run identity');
            started();
            switch (frame.kind) {
              case 'started':
                break;
              case 'request':
                if (
                  ++calls > QUICKJS_MAX_CALLS ||
                  pending.size >= QUICKJS_MAX_PENDING_CALLS ||
                  !Number.isSafeInteger(frame.id) ||
                  frame.id < 1 ||
                  seen.has(frame.id)
                )
                  throw new Error('Script host call limit exceeded');
                if (typeof frame.method !== 'string' || frame.method.length > 256)
                  throw new Error('Invalid script method');
                seen.add(frame.id);
                pending.add(frame.id);
                void request(frame);
                break;
              case 'notification':
                if (++calls > QUICKJS_MAX_CALLS) throw new Error('Script host call limit exceeded');
                if (frame.method !== 'script.output' && frame.method !== 'script.log')
                  throw new Error('Invalid script notification');
                if (frame.method === 'script.output' && pending.size > 0)
                  throw new Error('Script output arrived with pending host calls');
                options.onNotification(frame.method, frame.params);
                break;
              case 'stderr':
                if (typeof frame.line !== 'string') throw new Error('Invalid script error');
                options.onStderr(frame.line);
                break;
              case 'result':
                if (
                  !frame.result ||
                  !Number.isSafeInteger(frame.result.exitCode) ||
                  typeof frame.result.stderr !== 'string' ||
                  typeof frame.result.stdout !== 'string' ||
                  typeof frame.result.timedOut !== 'boolean'
                )
                  throw new Error('Invalid script result');
                if (frame.result.exitCode === 0 && pending.size > 0)
                  throw new Error('Script finished with pending host calls');
                finish(frame.result);
                break;
              default:
                throw new Error('Invalid script worker event');
            }
          } catch (error) {
            stop(message(error));
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          stop(event.message || 'Script worker failed');
        };
        worker.onmessageerror = () => stop('Invalid script worker message');
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        const data: Omit<QuickJSWorkerData, 'sdkModuleSource' | 'checksModuleSource'> = {
          source: options.source,
          scriptName: options.scriptName,
          init: options.init,
          timeoutMs: options.timeoutMs,
        };
        try {
          const json = JSON.stringify(data);
          account(json);
          worker.postMessage(json);
        } catch (error) {
          stop(message(error));
        }
      });
    } finally {
      worker.terminate();
      releaseMonitor();
    }
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8_000);
}
