import { type ScriptTemplateId, acquireSuspendMonitor, createAwakeTimeout } from '@bendyline/gezel';
import type { PortableScriptCompilation } from '@bendyline/gezel-script-runtime/compile';

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
