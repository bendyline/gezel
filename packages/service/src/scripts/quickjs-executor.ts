import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createAwakeTimeout } from '@bendyline/gezel';
import type {
  ScriptExecutionOptions,
  ScriptExecutionResult,
  ScriptExecutor,
} from '@bendyline/gezel-script-runtime';
import ts from 'typescript';
import { findServiceWorkerEntry } from '../utils/service-worker-entry.js';
import {
  QUICKJS_MAX_CALLS,
  QUICKJS_MAX_MESSAGE_CHARS,
  QUICKJS_MAX_PENDING_CALLS,
  QUICKJS_MAX_TOTAL_MESSAGE_CHARS,
  type QuickJSHostReply,
  type QuickJSWorkerData,
  type QuickJSWorkerMessage,
} from './quickjs-worker-protocol.js';
import { resolveSdkDir } from './sdk.js';

/**
 * Opt-in portable-script executor. Each guest runs in QuickJS-WASM on its own
 * worker; it never receives Node globals, credentials, paths, or a module resolver.
 * Host effects retain ScriptRunner's permission dispatcher. Termination prevents
 * further calls but cannot undo a host operation that has already started.
 */
export class QuickJSWorkerExecutor implements ScriptExecutor {
  async execute(options: ScriptExecutionOptions): Promise<ScriptExecutionResult> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('Invalid script timeout');
    }
    if (options.source.length > QUICKJS_MAX_MESSAGE_CHARS)
      throw new Error('Script source is too large');
    const deadline = createAwakeTimeout(options.timeoutMs, { pollMs: 100 });
    let worker: Worker | undefined;
    try {
      const cancelled = () => options.signal?.aborted === true;
      const failed = (message: string, timedOut = false): ScriptExecutionResult => ({
        exitCode: 1,
        stdout: '',
        stderr: message,
        timedOut,
      });
      if (cancelled()) return failed('Error: script execution cancelled');
      const entry = findServiceWorkerEntry(import.meta.url, 'quickjs');
      if (!entry) throw new Error('QuickJS worker is missing; rebuild the service');
      const sdk = await resolveSdkDir();
      const [sdkModuleSource, checksModuleSource] = await Promise.all([
        readFile(join(sdk, 'dist', 'portable.js'), 'utf8'),
        readFile(join(sdk, 'dist', 'checks.js'), 'utf8'),
      ]);
      const compiled = ts.transpileModule(options.source, {
        fileName: 'gezel-script.ts',
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
          sourceMap: false,
        },
        reportDiagnostics: true,
      });
      const error = compiled.diagnostics?.find(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      );
      if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
      if (cancelled()) return failed('Error: script execution cancelled');
      if (deadline.budget.expired()) return failed('Error: script execution timed out', true);
      const data: QuickJSWorkerData = {
        source: compiled.outputText,
        scriptName: options.scriptName,
        init: options.init,
        timeoutMs: Math.max(1, Math.floor(deadline.budget.remainingMs())),
        sdkModuleSource,
        checksModuleSource,
      };
      worker = new Worker(entry, {
        workerData: data,
        // Do not inherit development loaders or the test runner's worker flags.
        // Node 24's built-in type stripping handles the source fallback.
        execArgv: [],
        resourceLimits: {
          // Packaged core/schema and WASM bootstrap need more than 64 MB of
          // host heap; the guest has its separate 32 MB QuickJS memory limit.
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
      const runningWorker = worker;
      return await new Promise<ScriptExecutionResult>((resolve) => {
        let active = true;
        let calls = 0;
        let totalChars = 0;
        const pending = new Set<number>();
        const finish = (result: ScriptExecutionResult) => {
          if (!active) return;
          active = false;
          pending.clear();
          options.signal?.removeEventListener('abort', onAbort);
          deadline.signal.removeEventListener('abort', onTimeout);
          resolve(result);
        };
        const stop = (message: string, timedOut = false) => {
          if (!active) return;
          options.onStderr(message);
          finish(failed(message, timedOut));
        };
        const onAbort = () => stop('Error: script execution cancelled');
        const onTimeout = () =>
          stop(`Error: script execution timed out${deadline.budget.describeSuspension()}`, true);
        const account = (json: string) => {
          totalChars += json.length;
          if (
            json.length > QUICKJS_MAX_MESSAGE_CHARS ||
            totalChars > QUICKJS_MAX_TOTAL_MESSAGE_CHARS
          ) {
            throw new Error('Script message size limit exceeded');
          }
        };
        const respond = (reply: QuickJSHostReply) => {
          if (!active) return;
          try {
            const json = JSON.stringify(reply);
            account(json);
            runningWorker.postMessage(json);
          } catch (error) {
            stop(error instanceof Error ? error.message : String(error));
          }
        };
        const request = async (message: Extract<QuickJSWorkerMessage, { kind: 'request' }>) => {
          try {
            const result = await options.onRequest(message.method, message.params);
            respond({ runId: options.init.runId, id: message.id, result });
          } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;
            respond({
              runId: options.init.runId,
              id: message.id,
              error: {
                message: error instanceof Error ? error.message : String(error),
                ...(typeof code === 'string' ? { code } : {}),
              },
            });
          } finally {
            pending.delete(message.id);
          }
        };
        runningWorker.on('message', (json: unknown) => {
          if (!active) return;
          try {
            if (typeof json !== 'string') throw new Error('Invalid script worker message');
            account(json);
            const message = JSON.parse(json) as QuickJSWorkerMessage;
            if (message.runId !== options.init.runId)
              throw new Error('Invalid script run identity');
            switch (message.kind) {
              case 'request':
                if (
                  ++calls > QUICKJS_MAX_CALLS ||
                  pending.size >= QUICKJS_MAX_PENDING_CALLS ||
                  !Number.isSafeInteger(message.id) ||
                  pending.has(message.id)
                ) {
                  throw new Error('Script host call limit exceeded');
                }
                pending.add(message.id);
                void request(message);
                break;
              case 'notification':
                if (++calls > QUICKJS_MAX_CALLS) throw new Error('Script host call limit exceeded');
                if (message.method !== 'script.output' && message.method !== 'script.log')
                  throw new Error('Invalid script notification');
                options.onNotification(message.method, message.params);
                break;
              case 'stderr':
                options.onStderr(message.line);
                break;
              case 'result':
                finish(message.result);
                break;
              default:
                throw new Error('Invalid script worker event');
            }
          } catch (error) {
            stop(error instanceof Error ? error.message : String(error));
          }
        });
        runningWorker.once('error', (error) => stop(error.message));
        runningWorker.once('exit', (code) =>
          stop(`Error: script worker exited before a result (code ${code})`),
        );
        options.signal?.addEventListener('abort', onAbort, { once: true });
        deadline.signal.addEventListener('abort', onTimeout, { once: true });
        if (cancelled()) onAbort();
        else if (deadline.signal.aborted) onTimeout();
      });
    } finally {
      deadline.dispose();
      await worker?.terminate();
    }
  }
}
