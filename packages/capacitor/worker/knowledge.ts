/// <reference lib="webworker" />
/**
 * The knowledge worker the app serves as `knowledge-worker.js`: the daemon's
 * catalog host (inference/src/knowledge/catalog-host.ts) over the unmodified
 * catalog reader, with sqlite-wasm reading each `.gezk` archive in synchronous
 * byte ranges. Built by tsup with the worker's node:* stand-ins.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  type KnowledgeCatalogHost,
  createInProcessCatalogHost,
} from '../../inference/src/knowledge/catalog-host.js';
import { archiveFiles, httpFiles } from '../src/knowledge/files.js';
import { configureFs } from '../src/knowledge/node/fs.js';
import { installRangeVfs } from '../src/knowledge/range-vfs.js';
import { configureSqlite } from '../src/knowledge/sqlite-sync.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let host: KnowledgeCatalogHost | undefined;

async function init(options: { baseUrl: string; wasmUrl: string }) {
  // The typings omit the Emscripten module options it accepts.
  const sqlite3 = await (
    sqlite3InitModule as (config: object) => ReturnType<typeof sqlite3InitModule>
  )({
    locateFile: () => options.wasmUrl,
  });
  const files = archiveFiles(httpFiles(options.baseUrl));
  configureFs(files);
  installRangeVfs(sqlite3, 'gezk', files);
  configureSqlite(sqlite3, 'gezk');
  host = await createInProcessCatalogHost();
}

scope.onmessage = async ({ data }: MessageEvent<{ id: number; op: string; args: unknown[] }>) => {
  const { id, op, args } = data;
  try {
    let result: unknown;
    if (op === 'init') await init(args[0] as { baseUrl: string; wasmUrl: string });
    else {
      if (!host) throw new Error('The knowledge worker is not initialized');
      const method = host[op as keyof KnowledgeCatalogHost] as (...values: unknown[]) => unknown;
      result = await method.apply(host, args);
    }
    scope.postMessage({ id, result });
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
