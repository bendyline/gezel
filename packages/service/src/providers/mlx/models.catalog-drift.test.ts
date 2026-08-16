import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPayloadFingerprintHealsForTest } from '../../models/catalog-drift.js';
import { type MlxInstallEvent, MlxModelManager } from './models.js';

/**
 * MLX inventory answers "out of date" from the payload, not the version
 * string, and an update fetches only what actually moved.
 *
 * The regression this pins: removing a field from every chat-model manifest
 * bumped all their versions, and every installed MLX model went from "on
 * device" to "out of date — download it again" — roughly 100 GB of transfer
 * offered for an edit that changed no weights and that the runtime had
 * already picked up by resolving tuning from the live catalog.
 */

const MODEL_ID = 'fixture-mlx-q4';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const BASE_FILES: Record<string, Buffer> = {
  'config.json': Buffer.from(
    JSON.stringify({ architectures: ['Gemma3'], max_position_embeddings: 8192 }),
  ),
  'tokenizer_config.json': Buffer.from(JSON.stringify({ chat_template: '{{ messages }}' })),
  'model-00001.safetensors': Buffer.from('a'.repeat(600)),
  'model-00002.safetensors': Buffer.from('b'.repeat(600)),
};

function makeManager(opts: {
  home: string;
  version: string;
  files: Record<string, Buffer>;
  requested?: string[];
}): MlxModelManager {
  const fileList = Object.entries(opts.files).map(([name, bytes]) => ({
    name,
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
  }));
  const catalog = {
    get: async (kind: string, id: string) => {
      if (kind !== 'chat-model' || id !== MODEL_ID) return null;
      return {
        manifest: {
          kind: 'chat-model',
          id,
          name: 'Fixture MLX',
          version: opts.version,
          mlx: {
            huggingfaceRepo: 'mlx-community/fixture',
            revision: 'deadbeef',
            approxSizeBytes: fileList.reduce((sum, f) => sum + f.sizeBytes, 0),
            files: fileList,
          },
        },
      } as unknown as Awaited<ReturnType<CatalogService['get']>>;
    },
  } as unknown as CatalogService;

  const fetchImpl = (async (url: string) => {
    const name = decodeURIComponent((url.split('/').pop() ?? '').split('?')[0] ?? '');
    opts.requested?.push(name);
    const bytes = opts.files[name];
    if (!bytes) return new Response(null, { status: 404, statusText: 'Not Found' });
    return new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  }) as unknown as typeof fetch;

  return new MlxModelManager({ home: opts.home, catalog, fetchImpl });
}

async function drain(iter: AsyncIterable<MlxInstallEvent>): Promise<MlxInstallEvent[]> {
  const events: MlxInstallEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

let home: string;
beforeEach(async () => {
  resetPayloadFingerprintHealsForTest();
  home = await mkdtemp(join(tmpdir(), 'gezel-mlx-drift-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function installBaseline(): Promise<void> {
  const events = await drain(
    makeManager({ home, version: '1.1.2', files: BASE_FILES }).install(MODEL_ID),
  );
  expect(
    events.find((e) => e.type === 'done'),
    JSON.stringify(events),
  ).toBeDefined();
}

const manifestPath = (): string =>
  join(home, 'engines', 'mlx', 'models', MODEL_ID, 'manifest.json');

describe('MlxModelManager catalog drift', () => {
  it('does not call a model out of date when only the catalog metadata moved', async () => {
    await installBaseline();
    const bumped = makeManager({ home, version: '1.1.3', files: BASE_FILES });
    const [model] = await bumped.listInstalled();
    expect(model?.id).toBe(MODEL_ID);
    expect(model?.updateAvailable).toBeFalsy();
    expect(model?.availableVersion).toBeUndefined();
    await expect(bumped.getUpdateStatus(MODEL_ID)).resolves.toEqual({ updateAvailable: false });
  });

  it('calls it out of date, and says which file, when the weights are rebuilt', async () => {
    await installBaseline();
    const rebuilt = {
      ...BASE_FILES,
      'model-00002.safetensors': Buffer.from('z'.repeat(640)),
    };
    const [model] = await makeManager({ home, version: '1.2.0', files: rebuilt }).listInstalled();
    expect(model?.updateAvailable).toBe(true);
    expect(model?.availableVersion).toBe('1.2.0');
    expect(model?.updateReason).toContain('model-00002.safetensors');
  });

  it('records the catalog payload at install and leaves catalogVersion alone', async () => {
    await installBaseline();
    const installed = JSON.parse(await readFile(manifestPath(), 'utf8'));
    expect(installed.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.catalogVersion).toBe('1.1.2');
    // Every downloaded file's digest is recorded without a second pass over
    // the payload — this is what the reuse check reads on the next update.
    expect(Object.keys(installed.fileSha256).sort()).toEqual(Object.keys(BASE_FILES).sort());
  });

  it('backfills the fingerprint for a copy installed before it existed', async () => {
    await installBaseline();
    const stripped = JSON.parse(await readFile(manifestPath(), 'utf8'));
    stripped.payloadFingerprint = undefined;
    await writeFile(manifestPath(), JSON.stringify(stripped));

    const [model] = await makeManager({
      home,
      version: '1.1.3',
      files: BASE_FILES,
    }).listInstalled();
    expect(model?.updateAvailable).toBeFalsy();
    const healed = JSON.parse(await readFile(manifestPath(), 'utf8'));
    expect(healed.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(healed.catalogVersion).toBe('1.1.2');
  });

  it('downloads only the rebuilt shard when the model is updated', async () => {
    await installBaseline();
    const rebuiltShard = Buffer.from('z'.repeat(640));
    const requested: string[] = [];
    const updated = makeManager({
      home,
      version: '1.2.0',
      files: { ...BASE_FILES, 'model-00002.safetensors': rebuiltShard },
      requested,
    });

    const events = await drain(updated.install(MODEL_ID));
    expect(
      events.find((e) => e.type === 'done'),
      JSON.stringify(events),
    ).toBeDefined();
    expect(requested).toEqual(['model-00002.safetensors']);

    const dir = join(home, 'engines', 'mlx', 'models', MODEL_ID);
    expect(
      (await readFile(join(dir, 'model-00001.safetensors'))).equals(
        BASE_FILES['model-00001.safetensors']!,
      ),
    ).toBe(true);
    expect((await readFile(join(dir, 'model-00002.safetensors'))).equals(rebuiltShard)).toBe(true);

    const onDisk = JSON.parse(await readFile(manifestPath(), 'utf8'));
    expect(onDisk.catalogVersion).toBe('1.2.0');
    expect(onDisk.fileSha256['model-00001.safetensors']).toBe(
      sha256(BASE_FILES['model-00001.safetensors']!),
    );
    expect(onDisk.fileSha256['model-00002.safetensors']).toBe(sha256(rebuiltShard));
    await expect(updated.getUpdateStatus(MODEL_ID)).resolves.toEqual({ updateAvailable: false });
  });

  it('re-fetches the whole payload when the copy on disk recorded no digests', async () => {
    await installBaseline();
    const stripped = JSON.parse(await readFile(manifestPath(), 'utf8'));
    stripped.fileSha256 = undefined;
    await writeFile(manifestPath(), JSON.stringify(stripped));

    const requested: string[] = [];
    const events = await drain(
      makeManager({ home, version: '1.2.0', files: BASE_FILES, requested }).install(MODEL_ID),
    );
    expect(
      events.find((e) => e.type === 'done'),
      JSON.stringify(events),
    ).toBeDefined();
    expect(requested.sort()).toEqual(Object.keys(BASE_FILES).sort());
  });
});
