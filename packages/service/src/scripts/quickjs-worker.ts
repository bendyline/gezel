import { parentPort, workerData } from 'node:worker_threads';
import { awakeNow, startSuspendMonitor, stopSuspendMonitor } from '@bendyline/gezel';
import { QuickJSScriptExecutor } from '@bendyline/gezel-script-runtime/quickjs';
import type {
  QuickJSHostReply,
  QuickJSWorkerData,
  QuickJSWorkerMessage,
} from './quickjs-worker-protocol.js';

if (!parentPort) throw new Error('quickjs-worker must run in a worker thread');
const port = parentPort;
const data = workerData as QuickJSWorkerData;
const runId = data.init.runId;
let active = true;
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }
>();

function send(message: QuickJSWorkerMessage): void {
  if (active) port.postMessage(JSON.stringify(message));
}

port.on('message', (json: string) => {
  if (!active) return;
  const reply = JSON.parse(json) as QuickJSHostReply;
  if (reply.runId !== runId) return;
  const request = pending.get(reply.id);
  if (!request) return;
  pending.delete(reply.id);
  if (reply.error) {
    request.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
  } else {
    request.resolve(reply.result);
  }
});

startSuspendMonitor();
try {
  const executor = new QuickJSScriptExecutor({
    sdkModuleSource: data.sdkModuleSource,
    modules: { '@bendyline/gezel-sdk/checks': data.checksModuleSource },
    compile: (source) => source,
    now: awakeNow,
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackBytes: 512 * 1024,
  });
  const result = await executor.execute({
    source: data.source,
    scriptName: data.scriptName,
    init: data.init,
    timeoutMs: data.timeoutMs,
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
  const stderr = error instanceof Error ? error.message : String(error);
  send({ runId, kind: 'stderr', line: stderr });
  send({ runId, kind: 'result', result: { exitCode: 1, stdout: '', stderr, timedOut: false } });
} finally {
  active = false;
  pending.clear();
  stopSuspendMonitor();
  port.close();
}
