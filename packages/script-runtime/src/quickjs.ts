import {
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  getQuickJS,
} from 'quickjs-emscripten';
import type { ScriptExecutionOptions, ScriptExecutionResult, ScriptExecutor } from './index.js';

export interface QuickJSScriptExecutorOptions {
  /** Self-contained, trusted build of @bendyline/gezel-sdk/portable. */
  sdkModuleSource: string;
  /** Additional trusted, bundled modules; never resolve imports from disk or network. */
  modules?: Readonly<Record<string, string>>;
  compile(source: string, name: string): string;
  /** The host supplies its awake-time clock, including lifecycle suspension accounting. */
  now(): number;
  memoryLimitBytes?: number;
  maxStackBytes?: number;
  maxCalls?: number;
  maxPendingCalls?: number;
  maxMessageChars?: number;
  maxTotalMessageChars?: number;
}

const SDK = '@bendyline/gezel-sdk';
const PORTABLE = '@gezel-internal/portable-sdk';

const BOOTSTRAP = `
import { createGezelSDK, defineScript } from '${PORTABLE}';
const { __gezelInit, __gezelCall, __gezelNotify } = globalThis;
const parse = JSON.parse;
const stringify = JSON.stringify;
delete globalThis.__gezelInit;
delete globalThis.__gezelCall;
delete globalThis.__gezelNotify;
const gezel = createGezelSDK({
  init: parse(__gezelInit),
  async call(method, params) {
    return parse(await __gezelCall(method, stringify({ params }))).value;
  },
  notify(method, params) { __gezelNotify(method, stringify({ params })); }
});
globalThis.console = Object.freeze({
  log: (...args) => gezel.log(...args),
  info: (...args) => gezel.log(...args),
  warn: (...args) => gezel.log(...args),
  error: (...args) => gezel.log(...args)
});
export { gezel, defineScript };
`;

/**
 * Runs on a host-owned worker. QuickJS bounds guest memory/CPU; a worker keeps
 * synchronous guest execution off the product/UI event loop and lets the host
 * terminate it independently. No platform APIs are installed in the guest.
 */
export class QuickJSScriptExecutor implements ScriptExecutor {
  constructor(private readonly options: QuickJSScriptExecutorOptions) {}

  async execute(options: ScriptExecutionOptions): Promise<ScriptExecutionResult> {
    const config = this.options;
    const limit = (value: number | undefined, fallback: number): number => {
      const result = value ?? fallback;
      if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid script limit');
      return result;
    };
    const memoryLimit = limit(config.memoryLimitBytes, 32 * 1024 * 1024);
    const stackLimit = limit(config.maxStackBytes, 512 * 1024);
    const maxCalls = limit(config.maxCalls, 1_000);
    const maxPending = limit(config.maxPendingCalls, 32);
    const maxMessage = limit(config.maxMessageChars, 1_000_000);
    const maxTotal = limit(config.maxTotalMessageChars, 4_000_000);
    limit(options.timeoutMs, 300_000);
    const started = config.now();
    let timedOut = false;
    let exceededMemory = false;
    let active = true;
    let calls = 0;
    let totalChars = 0;
    let failure: string | undefined;
    const pending = new Set<QuickJSDeferredPromise>();
    const stopped = (): boolean => {
      if (config.now() - started >= options.timeoutMs) timedOut = true;
      return timedOut || exceededMemory || options.signal?.aborted === true;
    };
    const checkSize = (json: string): void => {
      totalChars += json.length;
      if (json.length > maxMessage || totalChars > maxTotal) {
        throw new Error('Script message size limit exceeded');
      }
    };
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    let vm: QuickJSContext;
    try {
      runtime.setMemoryLimit(memoryLimit);
      runtime.setMaxStackSize(stackLimit);
      vm = runtime.newContext();
    } catch (error) {
      runtime.dispose();
      throw error;
    }
    // QuickJS's own allocator limit catches ordinary allocation, but one large
    // typed allocation can grow the WebAssembly heap far past it inside a
    // single builtin, without the interpreter ever yielding to the interrupt.
    // Left alone that runs to the 32-bit address ceiling — two gigabytes — and
    // the heap never shrinks again, so measure growth and stop the guest.
    // Overshoot is bounded by one allocation step, not by the budget; the host
    // discards the whole worker after a run, which is what reclaims the heap.
    const heap = QuickJS.getWasmMemory();
    const heapBaseline = heap.buffer.byteLength;
    runtime.setInterruptHandler(() => {
      if (heap.buffer.byteLength - heapBaseline > memoryLimit) exceededMemory = true;
      return stopped();
    });
    let entry: QuickJSHandle | undefined;
    const decode = (method: QuickJSHandle, payload: QuickJSHandle) => {
      if (!active || stopped()) throw new Error('Script execution has ended');
      if (vm.typeof(method) !== 'string' || vm.typeof(payload) !== 'string') {
        throw new Error('Invalid script RPC message');
      }
      const name = vm.getString(method);
      if (name.length > 256) throw new Error('Invalid script RPC method');
      const json = vm.getString(payload);
      checkSize(json);
      const frame: unknown = JSON.parse(json);
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
        throw new Error('Invalid script RPC payload');
      }
      return { method: name, params: (frame as { params?: unknown }).params };
    };
    const report = (value: unknown): string => {
      const bound = (message: string) =>
        message.length > maxMessage ? `${message.slice(0, Math.max(0, maxMessage - 1))}…` : message;
      if (value && typeof value === 'object' && 'message' in value) {
        return bound(`Error: ${String(value.message)}`);
      }
      return bound(`Error: ${String(value)}`);
    };
    const settle = (promise: QuickJSDeferredPromise, value: unknown, error = false): void => {
      if (!active) return;
      try {
        if (stopped()) return;
        if (error) {
          const message = report(value).replace(/^Error: /, '');
          checkSize(message);
          const handle = vm.newError(message);
          try {
            const code = (value as { code?: unknown } | null)?.code;
            if (typeof code === 'string') {
              checkSize(code);
              const codeHandle = vm.newString(code);
              vm.setProp(handle, 'code', codeHandle);
              codeHandle.dispose();
            }
            promise.reject(handle);
          } finally {
            handle.dispose();
          }
        } else {
          const json = JSON.stringify({ value });
          checkSize(json);
          const handle = vm.newString(json);
          promise.resolve(handle);
          handle.dispose();
        }
      } catch (error) {
        failure = report(error);
      } finally {
        pending.delete(promise);
        promise.dispose();
      }
    };
    try {
      if (stopped()) throw new Error('Script execution cancelled or timed out');
      checkSize(options.source);
      const source = config.compile(options.source, options.scriptName);
      checkSize(source);
      const unavailable = (name: string) =>
        new Error(`Module "${name}" is unavailable in portable scripts`);
      runtime.setModuleLoader(
        (name) => {
          if (name === SDK) return BOOTSTRAP;
          if (name === PORTABLE) return config.sdkModuleSource;
          if (Object.hasOwn(config.modules ?? {}, name)) return config.modules![name]!;
          throw unavailable(name);
        },
        (base, requested) => {
          // The internal SDK module exists only so the bootstrap can wrap it in
          // the capability-checked `gezel` object. Guest code must not reach the
          // unwrapped module: the compiler rejects that import, but `eval` and a
          // dynamic `import()` never pass through the compiler, so the loader is
          // the only place that can refuse for certain.
          if (requested === PORTABLE && base !== SDK) throw unavailable(requested);
          return requested;
        },
      );
      const init = JSON.stringify(options.init);
      checkSize(init);
      const initHandle = vm.newString(init);
      vm.setProp(vm.global, '__gezelInit', initHandle);
      initHandle.dispose();
      const call = vm.newFunction('__gezelCall', (method, payload) => {
        const decoded = decode(method!, payload!);
        if (++calls > maxCalls || pending.size >= maxPending) {
          throw new Error('Script host call limit exceeded');
        }
        const promise = vm.newPromise();
        pending.add(promise);
        Promise.resolve()
          .then(() => {
            if (!active || stopped()) throw new Error('Script execution has ended');
            return options.onRequest(decoded.method, decoded.params);
          })
          .then(
            (value) => settle(promise, value),
            (error: unknown) => settle(promise, error, true),
          );
        return promise.handle;
      });
      vm.setProp(vm.global, '__gezelCall', call);
      call.dispose();
      const notify = vm.newFunction('__gezelNotify', (method, payload) => {
        const decoded = decode(method!, payload!);
        if (++calls > maxCalls) throw new Error('Script host call limit exceeded');
        if (decoded.method !== 'script.output' && decoded.method !== 'script.log') {
          throw new Error('Invalid script notification');
        }
        if (decoded.method === 'script.output' && pending.size > 0) {
          throw new Error('Portable scripts must await host calls before writing output');
        }
        options.onNotification(decoded.method, decoded.params);
        return vm.undefined;
      });
      vm.setProp(vm.global, '__gezelNotify', notify);
      notify.dispose();
      const evaluated = vm.evalCode(`import '${SDK}';\n${source}`, 'gezel-script.mjs', {
        type: 'module',
      });
      if (evaluated.error) {
        failure = report(vm.dump(evaluated.error));
        evaluated.error.dispose();
      } else {
        entry = evaluated.value;
        // Consecutive turns where nothing could possibly advance the guest.
        // Counted rather than acted on at once so a single tick between a host
        // reply and the job it queues is never mistaken for a stall.
        let idle = 0;
        while (!failure && !stopped()) {
          const jobs = runtime.executePendingJobs(128);
          if (jobs.error) {
            failure = report(vm.dump(jobs.error));
            jobs.error.dispose();
            break;
          }
          const state = vm.getPromiseState(entry);
          if (state.type === 'rejected') {
            failure = report(vm.dump(state.error));
            state.error.dispose();
            break;
          }
          if (state.type === 'fulfilled') {
            // For synchronous modules QuickJS returns the entry itself, not a new handle.
            if (state.value !== entry) state.value.dispose();
            if (pending.size > 0) {
              failure = 'Error: portable script finished with unawaited host calls';
              break;
            }
            if (!runtime.hasPendingJob()) break;
          }
          // A guest with no host call outstanding, no queued job and no timers
          // has nothing left that can resolve it: `await new Promise(() => {})`
          // or a dropped resolver. Waiting for the deadline would spin a phone's
          // CPU for minutes and hold the one script slot for the whole budget.
          if (state.type === 'pending' && pending.size === 0 && !runtime.hasPendingJob()) {
            if (++idle > 1) {
              failure = 'Error: portable script stopped without finishing; nothing can resume it';
              break;
            }
          } else idle = 0;
          await new Promise<void>((resolve) => setTimeout(resolve, pending.size ? 2 : 0));
        }
      }
      if (stopped()) {
        failure = exceededMemory
          ? 'Error: script exceeded its memory budget'
          : timedOut
            ? 'Error: script execution timed out'
            : 'Error: script execution cancelled';
      }
    } catch (error) {
      failure = report(error);
      stopped();
    } finally {
      active = false;
      for (const promise of pending) promise.dispose();
      pending.clear();
      entry?.dispose();
      vm.dispose();
      runtime.dispose();
    }
    if (failure) options.onStderr(failure);
    return { exitCode: failure ? 1 : 0, stdout: '', stderr: failure ?? '', timedOut };
  }
}
