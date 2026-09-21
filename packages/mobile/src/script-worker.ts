import { checksModuleSource, sdkModuleSource } from 'virtual:gezel-portable-sdk';
import { acquireSuspendMonitor, awakeNow } from '@bendyline/gezel';
import { QuickJSScriptExecutor } from '@bendyline/gezel-script-runtime/quickjs';
import type {
  QuickJSHostReply,
  QuickJSWorkerData,
  QuickJSWorkerMessage,
} from '@bendyline/gezel-script-runtime/worker-protocol';

// This is infrastructure in an isolated Web Worker. Guest code runs only in QuickJS.
const port = globalThis as unknown as {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  postMessage(value: string): void;
  close(): void;
};
let active = true;
let started = false;
let nextId = 0;
let runId = '';
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const send = (message: QuickJSWorkerMessage) => {
  if (active) port.postMessage(JSON.stringify(message));
};

port.onmessage = (event) => {
  if (!active || typeof event.data !== 'string') return;
  if (started) {
    const reply = JSON.parse(event.data) as QuickJSHostReply;
    if (reply.runId !== runId) return;
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.error)
      request.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
    else request.resolve(reply.result);
    return;
  }
  started = true;
  const data = JSON.parse(event.data) as Omit<
    QuickJSWorkerData,
    'sdkModuleSource' | 'checksModuleSource'
  >;
  runId = data.init.runId;
  void run(data);
};

async function run(data: Omit<QuickJSWorkerData, 'sdkModuleSource' | 'checksModuleSource'>) {
  const releaseMonitor = acquireSuspendMonitor();
  try {
    const executor = new QuickJSScriptExecutor({
      sdkModuleSource,
      modules: { '@bendyline/gezel-sdk/checks': checksModuleSource },
      compile: (source) => source,
      now: awakeNow,
      memoryLimitBytes: 32 * 1024 * 1024,
      maxStackBytes: 512 * 1024,
    });
    const result = await executor.execute({
      ...data,
      provenanceTrusted: false,
      trustedReadOnlyStandard: false,
      onRequest: (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          send({ runId, kind: 'request', id, method, params });
        }),
      onNotification: (method, params) => send({ runId, kind: 'notification', method, params }),
      onStdout: () => {},
      onStderr: (line) => send({ runId, kind: 'stderr', line }),
    });
    send({ runId, kind: 'result', result });
  } catch (error) {
    const stderr = (error instanceof Error ? error.message : String(error)).slice(0, 8_000);
    send({ runId, kind: 'result', result: { exitCode: 1, stdout: '', stderr, timedOut: false } });
  } finally {
    releaseMonitor();
    active = false;
    pending.clear();
    port.close();
  }
}
