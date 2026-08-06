/** Worker-thread host for GGUF metadata inspection.
 *
 * Large tokenizer vocabularies are cheap in bytes but expensive to walk. Keep
 * even the first uncached inspection away from Electron's main thread when the
 * service is embedded in a development app.
 */

import { parentPort } from 'node:worker_threads';
import { readGgufSummary } from './gguf-metadata.js';

if (!parentPort) throw new Error('gguf-metadata-worker must be run as a worker thread');
const port = parentPort;

interface GgufWorkerRequest {
  id: number;
  path: string;
  options?: { includeTensors?: boolean; includeTensorSizes?: boolean };
}

let chain: Promise<void> = Promise.resolve();

port.on('message', (request: GgufWorkerRequest) => {
  const run = async (): Promise<void> => {
    try {
      const summary = readGgufSummary(request.path, request.options);
      port.postMessage({ id: request.id, summary });
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  chain = chain.then(run, run);
});
