import { type ScriptTemplateId, acquireSuspendMonitor, createAwakeTimeout } from '@bendyline/gezel';
import type { PortableScriptCompilation } from '@bendyline/gezel-script-runtime/compile';
import type { CompiledPreviewModule } from '@bendyline/gezel-script-runtime/preview-module';

function request<T>(body: {
  name: string;
  source?: string;
  description?: string;
  template?: ScriptTemplateId;
}): Promise<T> {
  if (body.source && body.source.length > 256_000)
    return Promise.reject(new Error('Script source exceeds 256000 characters'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./script-compiler-worker.ts', import.meta.url), {
      type: 'module',
      name: 'gezel-script-compiler',
    });
    const releaseMonitor = acquireSuspendMonitor();
    const timeout = createAwakeTimeout(10_000);
    let active = true;
    const end = (error?: Error, value?: T) => {
      if (!active) return;
      active = false;
      timeout.dispose();
      timeout.signal.removeEventListener('abort', onTimeout);
      releaseMonitor();
      worker.terminate();
      error ? reject(error) : resolve(value!);
    };
    const onTimeout = () =>
      end(new Error(`Script compilation timed out${timeout.budget.describeSuspension()}`));
    timeout.signal.addEventListener('abort', onTimeout, { once: true });
    worker.onmessage = (event) => {
      if (timeout.budget.expired()) {
        onTimeout();
        return;
      }
      const message = event.data as { value?: T; error?: string };
      if (message.error) end(new Error(message.error));
      else end(undefined, message.value);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      end(new Error(event.message || 'Script compiler failed'));
    };
    worker.onmessageerror = () => end(new Error('Invalid script compiler result'));
    try {
      worker.postMessage(body);
    } catch (error) {
      end(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
const cache = new Map<string, Promise<PortableScriptCompilation>>();
export function compileMobileScript(
  source: string,
  name: string,
): Promise<PortableScriptCompilation> {
  const key = `${name}\0${source}`;
  let result = cache.get(key);
  if (!result) {
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    result = request<PortableScriptCompilation>({ name, source });
    cache.set(key, result);
    void result.catch(() => cache.delete(key));
  }
  return result.then((value) => structuredClone(value));
}
export const scaffoldMobileScript = (
  name: string,
  description?: string,
  template?: ScriptTemplateId,
) => request<string>({ name, description, template });

export type CompiledPreviewFile = CompiledPreviewModule & { path: string };
export interface PreviewModuleCompiler {
  compile(modules: { path: string; source: string }[]): Promise<CompiledPreviewFile[]>;
  dispose(): void;
}

/**
 * The script compiler's worker, held open for one preview: the preview
 * compiles its import graph a round at a time, and the worker loads
 * TypeScript only once for all of them. Running it here, rather than in a
 * worker of its own, keeps one copy of the compiler in the app.
 */
export function createPreviewModuleCompiler(): PreviewModuleCompiler {
  const worker = new Worker(new URL('./script-compiler-worker.ts', import.meta.url), {
    type: 'module',
    name: 'gezel-preview-compiler',
  });
  const releaseMonitor = acquireSuspendMonitor();
  const pending = new Map<
    number,
    { resolve(value: CompiledPreviewFile[]): void; reject(error: Error): void }
  >();
  let next = 0;
  let closed: Error | undefined;
  const close = (error: Error) => {
    if (closed) return;
    closed = error;
    worker.terminate();
    releaseMonitor();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.onmessage = (event) => {
    const message = event.data as { id: number; value?: CompiledPreviewFile[]; error?: string };
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value ?? []);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    close(new Error(event.message || 'The preview compiler failed'));
  };
  worker.onmessageerror = () => close(new Error('Invalid preview compiler result'));
  return {
    compile(modules) {
      if (closed) return Promise.reject(closed);
      const id = next++;
      const timeout = createAwakeTimeout(30_000);
      return new Promise<CompiledPreviewFile[]>((resolve, reject) => {
        const settle = () => {
          timeout.dispose();
          timeout.signal.removeEventListener('abort', onTimeout);
        };
        const onTimeout = () => {
          pending.delete(id);
          reject(
            new Error(`Compiling the preview timed out${timeout.budget.describeSuspension()}`),
          );
        };
        timeout.signal.addEventListener('abort', onTimeout, { once: true });
        pending.set(id, {
          resolve: (value) => {
            settle();
            resolve(value);
          },
          reject: (error) => {
            settle();
            reject(error);
          },
        });
        worker.postMessage({ kind: 'preview-modules', id, modules });
      });
    },
    dispose() {
      close(new Error('The preview compiler was closed'));
    },
  };
}
