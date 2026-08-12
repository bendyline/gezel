import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogItemDetail, ChatModelManifest } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type InstallEvent, LlamaCppModelManager } from './models.js';

/**
 * Build a synthetic GGUF blob with chosen metadata. Mirrors the
 * helper in gguf-metadata.test.ts but kept inline to avoid
 * cross-test-file imports (vitest resolves them differently than
 * production code).
 */
function buildGguf(opts: {
  arch?: string;
  contextLength?: number;
  fileType?: number;
  chatTemplate?: string;
  nextnPredictLayers?: number;
}): Buffer {
  const parts: Buffer[] = [];
  let metaCount = 0n;

  function u32(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
  }
  function u64(n: bigint): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n, 0);
    return b;
  }
  function ggufString(s: string): Buffer {
    const utf8 = Buffer.from(s, 'utf8');
    const out = Buffer.alloc(8 + utf8.byteLength);
    out.writeBigUInt64LE(BigInt(utf8.byteLength), 0);
    utf8.copy(out, 8);
    return out;
  }
  function metaString(key: string, value: string) {
    parts.push(ggufString(key));
    parts.push(u32(8 /* STRING */));
    parts.push(ggufString(value));
    metaCount++;
  }
  function metaU32(key: string, value: number) {
    parts.push(ggufString(key));
    parts.push(u32(4 /* UINT32 */));
    parts.push(u32(value));
    metaCount++;
  }

  // header
  parts.push(Buffer.from('GGUF', 'ascii'));
  parts.push(u32(3));
  parts.push(u64(0n)); // tensor_count
  parts.push(u64(0n)); // metadata-count placeholder, patched below

  // metadata
  metaString('general.architecture', opts.arch ?? 'qwen2');
  if (opts.contextLength !== undefined) {
    metaU32(`${opts.arch ?? 'qwen2'}.context_length`, opts.contextLength);
  }
  if (opts.fileType !== undefined) {
    metaU32('general.file_type', opts.fileType);
  }
  if (opts.chatTemplate !== undefined) {
    metaString('tokenizer.chat_template', opts.chatTemplate);
  }
  if (opts.nextnPredictLayers !== undefined) {
    metaU32(`${opts.arch ?? 'qwen2'}.nextn_predict_layers`, opts.nextnPredictLayers);
  }

  const blob = Buffer.concat(parts);
  blob.writeBigUInt64LE(metaCount, 16);
  return blob;
}

function fakeCatalog(entries: Map<string, ChatModelManifest>): CatalogService {
  return {
    async get(_kind: string, id: string) {
      const m = entries.get(id);
      if (!m) return null;
      return {
        sourceId: 'bundled',
        kind: 'chat-model',
        manifest: m,
      } satisfies CatalogItemDetail;
    },
    async list() {
      return [];
    },
    async readItemFile() {
      return null;
    },
    listSources() {
      return [{ id: 'bundled', label: 'Bundled' }];
    },
  } as unknown as CatalogService;
}

/**
 * Stub fetch that returns the given Buffer as a streamed response,
 * splitting it into chunks so the manager exercises its progress
 * loop. Reports a reasonable content-length.
 */
function streamingFetch(blob: Buffer, status = 200): typeof fetch {
  return (async () => {
    if (status !== 200) {
      return new Response('error body', { status });
    }
    let cursor = 0;
    const chunkSize = Math.max(1, Math.ceil(blob.byteLength / 5));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cursor >= blob.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(blob.byteLength, cursor + chunkSize);
        controller.enqueue(blob.subarray(cursor, end));
        cursor = end;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-length': String(blob.byteLength) },
    });
  }) as typeof fetch;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gezel-models-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function drain(it: AsyncIterable<InstallEvent>): Promise<InstallEvent[]> {
  const out: InstallEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('LlamaCppModelManager.install', () => {
  it('downloads, verifies sha256, extracts metadata, writes manifest', async () => {
    const blob = buildGguf({
      arch: 'qwen2',
      contextLength: 32768,
      fileType: 15,
      chatTemplate: '{%- if tools %}tools{%- endif %}',
    });
    const expected = sha256Hex(blob);
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'qwen-test',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'qwen-test',
            name: 'Qwen Test',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '2B',
            approxSizeBytes: blob.byteLength,
            supportsTools: true,
            llamaCpp: {
              huggingfaceRepo: 'test-org/test-repo',
              filename: 'test.gguf',
              sha256: expected,
              approxSizeBytes: blob.byteLength,
              quantization: 'Q4_K_M',
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl: streamingFetch(blob) });

    const events = await drain(mgr.install('qwen-test'));
    const types = events.map((e) => e.type);
    expect(types).toContain('verifying');
    expect(types).toContain('extracting-metadata');
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done && 'warning' in done ? done.warning : undefined).toBeUndefined();

    // The manifest landed and the weights file is the right size.
    const manifestPath = join(home, 'engines', 'llama-cpp', 'models', 'qwen-test', 'manifest.json');
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(onDisk.id).toBe('qwen-test');
    expect(onDisk.architecture).toBe('qwen2');
    expect(onDisk.contextWindow).toBe(32768);
    expect(onDisk.chatTemplatePresent).toBe(true);
    expect(onDisk.huggingfaceRepo).toBe('test-org/test-repo');
    expect(onDisk.sha256).toBe(expected);
  });

  it('engine:"ds4" installs from the ds4 source block into engines/ds4/models', async () => {
    const blob = buildGguf({
      arch: 'deepseek2',
      contextLength: 8192,
      fileType: 10,
      chatTemplate: '{%- if tools %}t{%- endif %}',
    });
    const expected = sha256Hex(blob);
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'deepseek-v4-flash-284b-q2',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'deepseek-v4-flash-284b-q2',
            name: 'DeepSeek V4 Flash',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'antirez' },
            version: '1.0.0',
            releasedAt: '2026-06-02T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '284B',
            approxSizeBytes: blob.byteLength,
            supportsTools: true,
            // No llamaCpp block — only ds4. A default-engine manager would
            // reject this ("no llama-cpp source"); engine:'ds4' must read it.
            ds4: {
              huggingfaceRepo: 'antirez/deepseek-v4-gguf',
              filename: 'ds4-test.gguf',
              sha256: expected,
              approxSizeBytes: blob.byteLength,
              residentBytes: 48 * 1024 ** 3,
              quantization: 'IQ2_XXS',
              cacheExpertsBytes: 32 * 1024 ** 3,
              ssdStreaming: true,
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const mgr = new LlamaCppModelManager({
      home,
      catalog,
      fetchImpl: streamingFetch(blob),
      engine: 'ds4',
    });

    const events = await drain(mgr.install('deepseek-v4-flash-284b-q2'));
    expect(events.find((e) => e.type === 'done')).toBeDefined();
    expect(events.find((e) => e.type === 'error')).toBeUndefined();

    // Lands under engines/ds4/models — NOT engines/llama-cpp.
    expect(
      existsSync(
        join(home, 'engines', 'ds4', 'models', 'deepseek-v4-flash-284b-q2', 'manifest.json'),
      ),
    ).toBe(true);
    expect(
      existsSync(join(home, 'engines', 'llama-cpp', 'models', 'deepseek-v4-flash-284b-q2')),
    ).toBe(false);

    // resolveModel returns the installed weights path the ds4 provider uses.
    const resolved = await mgr.resolveModel('deepseek-v4-flash-284b-q2');
    expect(resolved?.weightsPath).toContain(join('engines', 'ds4', 'models'));
  });

  it('downloads from the pinned revision when the source sets one', async () => {
    const blob = buildGguf({ arch: 'qwen2', contextLength: 8192, fileType: 15 });
    const expected = sha256Hex(blob);
    const commit = 'a'.repeat(40);
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'pinned',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'pinned',
            name: 'Pinned',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '2B',
            approxSizeBytes: blob.byteLength,
            supportsTools: true,
            llamaCpp: {
              huggingfaceRepo: 'test-org/test-repo',
              revision: commit,
              filename: 'test.gguf',
              sha256: expected,
              approxSizeBytes: blob.byteLength,
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(typeof input === 'string' ? input : input.toString());
      return new Response(blob, {
        status: 200,
        headers: { 'content-length': String(blob.byteLength) },
      });
    }) as typeof fetch;
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl });

    await drain(mgr.install('pinned'));
    expect(requested.some((u) => u.includes(`/resolve/${commit}/`))).toBe(true);
    expect(requested.every((u) => !u.includes('/resolve/main/'))).toBe(true);
  });

  it('falls back to /resolve/main/ when no revision is pinned', async () => {
    const blob = buildGguf({ arch: 'qwen2', contextLength: 8192, fileType: 15 });
    const expected = sha256Hex(blob);
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'unpinned',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'unpinned',
            name: 'Unpinned',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '2B',
            approxSizeBytes: blob.byteLength,
            supportsTools: true,
            llamaCpp: {
              huggingfaceRepo: 'test-org/test-repo',
              filename: 'test.gguf',
              sha256: expected,
              approxSizeBytes: blob.byteLength,
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(typeof input === 'string' ? input : input.toString());
      return new Response(blob, {
        status: 200,
        headers: { 'content-length': String(blob.byteLength) },
      });
    }) as typeof fetch;
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl });

    await drain(mgr.install('unpinned'));
    expect(requested.some((u) => u.includes('/resolve/main/'))).toBe(true);
  });

  it('surfaces a warning when the GGUF lacks a chat_template', async () => {
    const blob = buildGguf({ arch: 'gemma3', contextLength: 8192 });
    const expected = sha256Hex(blob);
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'no-template',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'no-template',
            name: 'No Template',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '2B',
            approxSizeBytes: blob.byteLength,
            supportsTools: false,
            llamaCpp: {
              huggingfaceRepo: 'x/y',
              filename: 'test.gguf',
              sha256: expected,
              approxSizeBytes: blob.byteLength,
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl: streamingFetch(blob) });
    const events = await drain(mgr.install('no-template'));
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done && 'warning' in done ? done.warning : undefined).toMatch(/chat template/i);
  });

  it('onInstalled fires once on done (even when the hook throws) and never on error', async () => {
    const blob = buildGguf({ arch: 'qwen2', contextLength: 4096, chatTemplate: 'x' });
    const expected = sha256Hex(blob);
    const manifest = (id: string, sha: string): ChatModelManifest =>
      ({
        schemaVersion: 1,
        kind: 'chat-model',
        id,
        name: id,
        description: 'fixture',
        tags: [],
        maintainer: { name: 'Test' },
        version: '1.0.0',
        releasedAt: '2026-04-22T00:00:00Z',
        availableVersions: ['1.0.0'],
        parameterSize: '2B',
        approxSizeBytes: blob.byteLength,
        supportsTools: true,
        llamaCpp: {
          huggingfaceRepo: 'x/y',
          filename: `${id}.gguf`,
          sha256: sha,
          approxSizeBytes: blob.byteLength,
        },
      }) as ChatModelManifest;

    const seen: Array<{ engine: string; id: string }> = [];
    const okCatalog = fakeCatalog(
      new Map<string, ChatModelManifest>([['hooked', manifest('hooked', expected)]]),
    );
    const mgr = new LlamaCppModelManager({
      home,
      catalog: okCatalog,
      fetchImpl: streamingFetch(blob),
      onInstalled: (info) => {
        seen.push(info);
        throw new Error('hook exploded — must not break the install');
      },
    });
    const events = await drain(mgr.install('hooked'));
    expect(events.find((e) => e.type === 'done')).toBeDefined();
    expect(seen).toEqual([{ engine: 'llama-cpp', id: 'hooked' }]);

    // Failed install (sha mismatch) → hook never fires.
    const badCatalog = fakeCatalog(
      new Map<string, ChatModelManifest>([['bad', manifest('bad', '0'.repeat(64))]]),
    );
    const failMgr = new LlamaCppModelManager({
      home,
      catalog: badCatalog,
      fetchImpl: streamingFetch(blob),
      onInstalled: (info) => seen.push(info),
    });
    const failEvents = await drain(failMgr.install('bad'));
    expect(failEvents.find((e) => e.type === 'error')).toBeDefined();
    expect(seen).toHaveLength(1);
  });

  it('errors and cleans up when sha256 does not match', async () => {
    const blob = buildGguf({ arch: 'qwen2', contextLength: 4096, chatTemplate: 'x' });
    const wrongSha = '0'.repeat(64);
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'tampered',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'tampered',
            name: 'Tampered',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '2B',
            approxSizeBytes: blob.byteLength,
            supportsTools: false,
            llamaCpp: {
              huggingfaceRepo: 'x/y',
              filename: 'tampered.gguf',
              sha256: wrongSha,
              approxSizeBytes: blob.byteLength,
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl: streamingFetch(blob) });
    const events = await drain(mgr.install('tampered'));
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err && 'error' in err ? err.error : '').toMatch(
      /has changed since this version of Gezel/,
    );
    expect(err && 'mismatch' in err ? err.mismatch : undefined).toBeDefined();
    // No manifest written; partial cleaned up.
    const manifestPath = join(home, 'engines', 'llama-cpp', 'models', 'tampered', 'manifest.json');
    let exists = false;
    try {
      readFileSync(manifestPath);
      exists = true;
    } catch {
      /* expected */
    }
    expect(exists).toBe(false);
  });

  it('rejects ids not in the catalog', async () => {
    const catalog = fakeCatalog(new Map());
    const mgr = new LlamaCppModelManager({
      home,
      catalog,
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    const events = await drain(mgr.install('nope'));
    const err = events.find((e) => e.type === 'error');
    expect(err && 'error' in err ? err.error : '').toMatch(/not in catalog/);
  });

  it('rejects entries with no llamaCpp source', async () => {
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'ollama-only',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'ollama-only',
            name: 'Ollama Only',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '2B',
            approxSizeBytes: 1,
            supportsTools: false,
            ollama: { tag: 'ollama-only' },
          } as ChatModelManifest,
        ],
      ]),
    );
    const mgr = new LlamaCppModelManager({
      home,
      catalog,
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    const events = await drain(mgr.install('ollama-only'));
    const err = events.find((e) => e.type === 'error');
    expect(err && 'error' in err ? err.error : '').toMatch(/no llama-cpp source/);
  });

  it('rejects unsafe ids', async () => {
    const mgr = new LlamaCppModelManager({
      home,
      catalog: fakeCatalog(new Map()),
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    const events = await drain(mgr.install('../escape'));
    expect(events[0]?.type).toBe('error');
  });

  it('downloads sharded GGUFs and records the first shard as the entry point', async () => {
    const firstShard = buildGguf({
      arch: 'gpt-oss',
      contextLength: 131072,
      fileType: 15,
      chatTemplate: '{%- if tools %}tools{%- endif %}',
    });
    const secondShard = Buffer.from('TENSOR-DATA-FOR-SHARD-2', 'utf8');
    const firstSha = sha256Hex(firstShard);
    const secondSha = sha256Hex(secondShard);
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'big-moe',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'big-moe',
            name: 'Big MoE',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '117B',
            approxSizeBytes: firstShard.byteLength + secondShard.byteLength,
            supportsTools: true,
            llamaCpp: {
              huggingfaceRepo: 'test-org/big-moe-GGUF',
              shards: [
                {
                  name: 'Q4_K_M/big-moe-Q4_K_M-00001-of-00002.gguf',
                  sha256: firstSha,
                  sizeBytes: firstShard.byteLength,
                },
                {
                  name: 'Q4_K_M/big-moe-Q4_K_M-00002-of-00002.gguf',
                  sha256: secondSha,
                  sizeBytes: secondShard.byteLength,
                },
              ],
              approxSizeBytes: firstShard.byteLength + secondShard.byteLength,
              quantization: 'Q4_K_M',
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    // Per-URL fetch stub. The downloader builds `…/resolve/main/<encoded
    // path>?download=true`, so we route by path suffix.
    const fetchImpl = (async (input: string | URL) => {
      const href = typeof input === 'string' ? input : input.toString();
      if (href.includes('00001-of-00002')) {
        return new Response(firstShard, {
          status: 200,
          headers: { 'content-length': String(firstShard.byteLength) },
        });
      }
      if (href.includes('00002-of-00002')) {
        return new Response(secondShard, {
          status: 200,
          headers: { 'content-length': String(secondShard.byteLength) },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl });

    const events = await drain(mgr.install('big-moe'));
    const done = events.find((e) => e.type === 'done');
    expect(done, JSON.stringify(events)).toBeDefined();

    // Both shards landed under the model directory, flattened to
    // basenames (the catalog name had a subdirectory).
    const dir = join(home, 'engines', 'llama-cpp', 'models', 'big-moe');
    const onDisk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(onDisk.weightsFilename).toBe('big-moe-Q4_K_M-00001-of-00002.gguf');
    expect(onDisk.shards).toHaveLength(2);
    expect(onDisk.shards[0].filename).toBe('big-moe-Q4_K_M-00001-of-00002.gguf');
    expect(onDisk.shards[1].filename).toBe('big-moe-Q4_K_M-00002-of-00002.gguf');
    expect(onDisk.architecture).toBe('gpt-oss');
    expect(onDisk.contextWindow).toBe(131072);
    // The first shard's bytes match what we sent (metadata header passes
    // the GGUF parser).
    const onDiskFirst = readFileSync(join(dir, 'big-moe-Q4_K_M-00001-of-00002.gguf'));
    expect(onDiskFirst.byteLength).toBe(firstShard.byteLength);
  });

  it('downloads the mmproj sidecar and records mmprojPath when native vision is opted in', async () => {
    const weights = buildGguf({
      arch: 'nemotron_h',
      contextLength: 131072,
      fileType: 15,
      chatTemplate: '{%- if tools %}tools{%- endif %}',
    });
    // mmproj is a real GGUF on disk too (own header), but we don't
    // parse it — the installer treats it as an opaque verified blob.
    // A non-GGUF buffer is fine here because the install path only
    // reads metadata from the WEIGHTS file.
    const mmproj = Buffer.from('MMPROJ-PROJECTOR-WEIGHTS', 'utf8');
    const weightsSha = sha256Hex(weights);
    const mmprojSha = sha256Hex(mmproj);
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'mm-test',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'mm-test',
            name: 'Multimodal Test',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '30B',
            approxSizeBytes: weights.byteLength + mmproj.byteLength,
            supportsTools: true,
            llamaCpp: {
              huggingfaceRepo: 'test-org/multimodal-GGUF',
              filename: 'model-Q4_K_M.gguf',
              sha256: weightsSha,
              approxSizeBytes: weights.byteLength,
              quantization: 'Q4_K_M',
              mmproj: {
                filename: 'mmproj-BF16.gguf',
                sha256: mmprojSha,
                sizeBytes: mmproj.byteLength,
              },
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const fetchImpl = (async (input: string | URL) => {
      const href = typeof input === 'string' ? input : input.toString();
      const buf = href.includes('mmproj') ? mmproj : weights;
      return new Response(buf, {
        status: 200,
        headers: { 'content-length': String(buf.byteLength) },
      });
    }) as typeof fetch;
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl });
    const events = await drain(mgr.install('mm-test', { includeMmproj: true }));
    const done = events.find((e) => e.type === 'done');
    expect(done, JSON.stringify(events)).toBeDefined();

    const dir = join(home, 'engines', 'llama-cpp', 'models', 'mm-test');
    const onDisk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(onDisk.weightsFilename).toBe('model-Q4_K_M.gguf');
    expect(onDisk.mmprojFilename).toBe('mmproj-BF16.gguf');
    // No shards entry for a single-weights+mmproj install.
    expect(onDisk.shards).toBeUndefined();
    // The mmproj file landed alongside the weights, byte-identical.
    const onDiskMmproj = readFileSync(join(dir, 'mmproj-BF16.gguf'));
    expect(onDiskMmproj.equals(mmproj)).toBe(true);

    // listInstalled surfaces the mmproj path that the supervisor uses
    // for `--mmproj`.
    const installed = await mgr.listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.mmprojPath).toBe(join(dir, 'mmproj-BF16.gguf'));
  });

  it('always downloads and resolves a speculative draft-model sidecar', async () => {
    const weights = buildGguf({
      arch: 'gemma4',
      contextLength: 131072,
      chatTemplate: 'gemma-template',
    });
    const draft = buildGguf({
      arch: 'gemma4-assistant',
      nextnPredictLayers: 4,
    });
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'mtp-sidecar-test',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'mtp-sidecar-test',
            name: 'MTP Sidecar Test',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-07-28T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '12B',
            approxSizeBytes: weights.byteLength,
            supportsTools: true,
            llamaCpp: {
              huggingfaceRepo: 'test-org/gemma-GGUF',
              filename: 'gemma-Q4_K_M.gguf',
              sha256: sha256Hex(weights),
              approxSizeBytes: weights.byteLength,
              quantization: 'Q4_K_M',
              draftModel: {
                filename: 'MTP/mtp-gemma-Q4_0.gguf',
                sha256: sha256Hex(draft),
                sizeBytes: draft.byteLength,
              },
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const href = typeof input === 'string' ? input : input.toString();
      requested.push(href);
      const buf = href.includes('mtp-gemma') ? draft : weights;
      return new Response(buf, {
        status: 200,
        headers: { 'content-length': String(buf.byteLength) },
      });
    }) as typeof fetch;
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl });
    const events = await drain(mgr.install('mtp-sidecar-test'));
    expect(
      events.find((event) => event.type === 'done'),
      JSON.stringify(events),
    ).toBeDefined();
    expect(requested.some((url) => url.includes('MTP/mtp-gemma'))).toBe(true);

    const dir = join(home, 'engines', 'llama-cpp', 'models', 'mtp-sidecar-test');
    const onDisk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(onDisk.draftModelFilename).toBe('mtp-gemma-Q4_0.gguf');
    expect(readFileSync(join(dir, 'mtp-gemma-Q4_0.gguf')).equals(draft)).toBe(true);

    const installed = await mgr.listInstalled();
    expect(installed[0]?.draftModelPath).toBe(join(dir, 'mtp-gemma-Q4_0.gguf'));
  });

  // Default OFF is the load-bearing half. Loading a projector makes
  // llama-server 501 on slot save/restore, which latches disk-KV prefix
  // caching off for that model process-wide — a cost paid on every text turn.
  // Installing a model that merely *ships* a projector must not opt the user
  // into that silently.
  it('skips the mmproj sidecar by default so prompt caching survives', async () => {
    const weights = buildGguf({
      arch: 'nemotron_h',
      contextLength: 131072,
      fileType: 15,
      chatTemplate: '{%- if tools %}tools{%- endif %}',
    });
    const mmproj = Buffer.from('MMPROJ-PROJECTOR-WEIGHTS', 'utf8');
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'mm-default',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'mm-default',
            name: 'Multimodal Default',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '30B',
            approxSizeBytes: weights.byteLength,
            supportsTools: true,
            llamaCpp: {
              huggingfaceRepo: 'test-org/multimodal-GGUF',
              filename: 'model-Q4_K_M.gguf',
              sha256: sha256Hex(weights),
              approxSizeBytes: weights.byteLength,
              quantization: 'Q4_K_M',
              mmproj: {
                filename: 'mmproj-BF16.gguf',
                sha256: sha256Hex(mmproj),
                sizeBytes: mmproj.byteLength,
              },
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const href = typeof input === 'string' ? input : input.toString();
      requested.push(href);
      return new Response(weights, {
        status: 200,
        headers: { 'content-length': String(weights.byteLength) },
      });
    }) as typeof fetch;
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl });
    await drain(mgr.install('mm-default'));

    expect(requested.some((u) => u.includes('mmproj'))).toBe(false);
    const dir = join(home, 'engines', 'llama-cpp', 'models', 'mm-default');
    const onDisk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(onDisk.weightsFilename).toBe('model-Q4_K_M.gguf');
    expect(onDisk.mmprojFilename).toBeUndefined();
    // Without a projector path the capability resolver keeps the model on the
    // recognition path, which is exactly right.
    const installed = await mgr.listInstalled();
    expect(installed[0]?.mmprojPath).toBeUndefined();
  });

  it('fails the sharded install loudly when a shard sha256 does not match', async () => {
    const firstShard = buildGguf({ arch: 'gpt-oss', contextLength: 8192, chatTemplate: 'x' });
    const secondShard = Buffer.from('CORRUPTED-PAYLOAD', 'utf8');
    const firstSha = sha256Hex(firstShard);
    const wrongSecondSha = '0'.repeat(64);
    const catalog = fakeCatalog(
      new Map<string, ChatModelManifest>([
        [
          'tampered-shards',
          {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'tampered-shards',
            name: 'Tampered Shards',
            description: 'fixture',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            availableVersions: ['1.0.0'],
            parameterSize: '117B',
            approxSizeBytes: firstShard.byteLength + secondShard.byteLength,
            supportsTools: false,
            llamaCpp: {
              huggingfaceRepo: 'x/y',
              shards: [
                {
                  name: 'shard-00001-of-00002.gguf',
                  sha256: firstSha,
                  sizeBytes: firstShard.byteLength,
                },
                {
                  name: 'shard-00002-of-00002.gguf',
                  sha256: wrongSecondSha,
                  sizeBytes: secondShard.byteLength,
                },
              ],
              approxSizeBytes: firstShard.byteLength + secondShard.byteLength,
            },
          } as ChatModelManifest,
        ],
      ]),
    );
    const fetchImpl = (async (input: string | URL) => {
      const href = typeof input === 'string' ? input : input.toString();
      const buf = href.includes('00001') ? firstShard : secondShard;
      return new Response(buf, {
        status: 200,
        headers: { 'content-length': String(buf.byteLength) },
      });
    }) as typeof fetch;
    const mgr = new LlamaCppModelManager({ home, catalog, fetchImpl });
    const events = await drain(mgr.install('tampered-shards'));
    const err = events.find((e) => e.type === 'error');
    expect(err && 'error' in err ? err.error : '').toMatch(
      /has changed since this version of Gezel/,
    );
    expect(err && 'mismatch' in err ? err.mismatch : undefined).toBeDefined();
    // No installed manifest written.
    const manifestPath = join(
      home,
      'engines',
      'llama-cpp',
      'models',
      'tampered-shards',
      'manifest.json',
    );
    let exists = false;
    try {
      readFileSync(manifestPath);
      exists = true;
    } catch {
      /* expected */
    }
    expect(exists).toBe(false);
  });
});

describe('LlamaCppModelManager.listInstalled / delete / resolveDefaultModelPath', () => {
  it('returns [] when no models directory exists', async () => {
    const mgr = new LlamaCppModelManager({
      home,
      catalog: fakeCatalog(new Map()),
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    const list = await mgr.listInstalled();
    expect(list).toEqual([]);
    expect(await mgr.resolveDefaultModelPath()).toBeNull();
  });

  it('lists installed models from manifest.json files', async () => {
    const dir = join(home, 'engines', 'llama-cpp', 'models', 'qwen-test');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'qwen-test',
        name: 'Qwen Test',
        approxSizeBytes: 1024,
        weightsFilename: 'q.gguf',
        sha256: 'a'.repeat(64),
        installedAt: '2026-04-22T00:00:00Z',
        catalogId: 'qwen-test',
        catalogVersion: '1.0.0',
        huggingfaceRepo: 'x/y',
        chatTemplatePresent: true,
        contextWindow: 32768,
      }),
    );
    writeFileSync(join(dir, 'q.gguf'), Buffer.alloc(0));

    const mgr = new LlamaCppModelManager({
      home,
      catalog: fakeCatalog(new Map()),
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    const list = await mgr.listInstalled();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('qwen-test');
    expect(list[0]?.contextWindow).toBe(32768);
    expect(await mgr.resolveDefaultModelPath()).toBe(join(dir, 'q.gguf'));
    // resolveDefaultModel returns the full summary — what
    // buildLlamaCppProvider uses to pick up contextWindow for
    // `--ctx-size`. Without this the engine would boot at a flat
    // 16K for every model regardless of its native capacity.
    const defaultModel = await mgr.resolveDefaultModel();
    expect(defaultModel?.id).toBe('qwen-test');
    expect(defaultModel?.contextWindow).toBe(32768);
    expect(defaultModel?.weightsPath).toBe(join(dir, 'q.gguf'));

    // resolveModel(id) is the companion lookup for when the user has
    // pinned an explicit default via config.defaultModel['llama-cpp'].
    expect((await mgr.resolveModel('qwen-test'))?.id).toBe('qwen-test');
    expect(await mgr.resolveModel('does-not-exist')).toBeNull();

    // Drift-detection provenance: resolveModel surfaces the catalog
    // version and weights sha recorded at install, so buildSessionOpts
    // can warn when the download is stale vs the catalog's current
    // version (the garbled-gemma failure mode).
    const resolved = await mgr.resolveModel('qwen-test');
    expect(resolved?.catalogVersion).toBe('1.0.0');
    expect(resolved?.sha256).toBe('a'.repeat(64));
  });

  it('flags updateAvailable when the catalog ships a newer version than the install', async () => {
    const dir = join(home, 'engines', 'llama-cpp', 'models', 'drift-test');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'drift-test',
        name: 'Drift Test',
        approxSizeBytes: 1024,
        weightsFilename: 'd.gguf',
        sha256: 'b'.repeat(64),
        installedAt: '2026-04-22T00:00:00Z',
        catalogId: 'drift-test',
        catalogVersion: '1.0.0',
        huggingfaceRepo: 'x/y',
        quantization: 'Q4_K_M',
        chatTemplatePresent: true,
      }),
    );
    writeFileSync(join(dir, 'd.gguf'), Buffer.alloc(0));

    const manifest = (version: string): ChatModelManifest =>
      ({
        schemaVersion: 1,
        kind: 'chat-model',
        id: 'drift-test',
        name: 'Drift Test',
        description: 'fixture',
        tags: [],
        maintainer: { name: 'Test' },
        version,
        releasedAt: '2026-06-06T00:00:00Z',
        availableVersions: [version],
        parameterSize: '12B',
        approxSizeBytes: 1024,
        supportsTools: true,
        llamaCpp: {
          huggingfaceRepo: 'x/y',
          filename: 'd.gguf',
          sha256: 'c'.repeat(64),
          approxSizeBytes: 1024,
          quantization: 'UD-Q4_K_XL',
        },
      }) as ChatModelManifest;

    // Catalog has moved to 1.1.0 → newer build available.
    const newer = new LlamaCppModelManager({
      home,
      catalog: fakeCatalog(new Map<string, ChatModelManifest>([['drift-test', manifest('1.1.0')]])),
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    const [drifted] = await newer.listInstalled();
    expect(drifted?.updateAvailable).toBe(true);
    expect(drifted?.availableVersion).toBe('1.1.0');

    // Catalog still at the installed version → no update flag.
    const same = new LlamaCppModelManager({
      home,
      catalog: fakeCatalog(new Map<string, ChatModelManifest>([['drift-test', manifest('1.0.0')]])),
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    const [unchanged] = await same.listInstalled();
    expect(unchanged?.updateAvailable).toBeFalsy();
    expect(unchanged?.availableVersion).toBeUndefined();
  });

  it('skips malformed manifests rather than crashing', async () => {
    const dir = join(home, 'engines', 'llama-cpp', 'models', 'broken');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{not json');
    const mgr = new LlamaCppModelManager({
      home,
      catalog: fakeCatalog(new Map()),
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    const list = await mgr.listInstalled();
    expect(list).toEqual([]);
    await expect(mgr.listUnrecognized()).resolves.toEqual([
      expect.objectContaining({
        id: 'broken',
        canUpdate: false,
        reason: expect.stringContaining('not valid JSON'),
      }),
    ]);
  });

  it('keeps an old ds4 manifest visible for update or removal', async () => {
    const id = 'deepseek-v4-flash-284b-q2';
    const dir = join(home, 'engines', 'ds4', 'models', id);
    require('node:fs').mkdirSync(dir, { recursive: true });
    const weights = Buffer.from('GGUFlegacy-ds4-payload');
    writeFileSync(join(dir, 'legacy.gguf'), weights);
    // This is the pre-installed-manifest shape found on the user's device:
    // enough provenance to identify the payload, but no current display /
    // lifecycle fields. It must stay non-runnable without becoming invisible.
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id,
        engine: 'ds4',
        filename: 'legacy.gguf',
        huggingfaceRepo: 'antirez/deepseek-v4-gguf',
        revision: 'legacy-revision',
        sha256: 'a'.repeat(64),
        approxSizeBytes: weights.byteLength,
        quantization: 'IQ2_XXS',
      }),
    );
    const catalogManifest = {
      schemaVersion: 1,
      kind: 'chat-model',
      id,
      name: 'DeepSeek V4 Flash (IQ2_XXS)',
      description: 'fixture',
      tags: [],
      maintainer: { name: 'antirez' },
      version: '1.1.0',
      releasedAt: '2026-08-01T00:00:00Z',
      availableVersions: ['1.1.0'],
      parameterSize: '284B',
      approxSizeBytes: weights.byteLength,
      supportsTools: true,
      ds4: {
        huggingfaceRepo: 'antirez/deepseek-v4-gguf',
        filename: 'current-0731.gguf',
        sha256: 'b'.repeat(64),
        approxSizeBytes: weights.byteLength,
        residentBytes: 36 * 1024 ** 3,
        quantization: 'IQ2_XXS',
        cacheExpertsBytes: 32 * 1024 ** 3,
        ssdStreaming: true,
      },
    } as ChatModelManifest;
    const mgr = new LlamaCppModelManager({
      home,
      engine: 'ds4',
      catalog: fakeCatalog(new Map([[id, catalogManifest]])),
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });

    expect(await mgr.listInstalled()).toEqual([]);
    await expect(mgr.listUnrecognized()).resolves.toEqual([
      expect.objectContaining({
        id,
        name: 'DeepSeek V4 Flash (IQ2_XXS)',
        canUpdate: true,
        bytes: expect.any(Number),
        reason: expect.stringContaining('older version'),
      }),
    ]);

    await mgr.delete(id);
    expect(existsSync(dir)).toBe(false);
  });

  it('delete removes the model directory', async () => {
    const dir = join(home, 'engines', 'llama-cpp', 'models', 'doomed');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q.gguf'), Buffer.alloc(0));
    const mgr = new LlamaCppModelManager({
      home,
      catalog: fakeCatalog(new Map()),
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    await mgr.delete('doomed');
    const list = await mgr.listInstalled();
    expect(list).toEqual([]);
  });

  it('delete refuses unsafe ids', async () => {
    const mgr = new LlamaCppModelManager({
      home,
      catalog: fakeCatalog(new Map()),
      fetchImpl: streamingFetch(Buffer.alloc(0)),
    });
    await expect(mgr.delete('../etc')).rejects.toThrow(/unsafe/);
  });
});
