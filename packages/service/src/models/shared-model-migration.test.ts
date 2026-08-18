import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezmodelBundleManifest, SharedModelMigrationRequest } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineEngineBridge } from '../machine-engine/bridge.js';
import type { ModelBundleSource } from './bundle-storage.js';
import {
  SharedModelMigrationManager,
  type SharedModelSourceHome,
  defaultSourceHomes,
} from './shared-model-migration.js';

const MODEL_ID = 'llama3.2-3b-q4';
const WEIGHTS = Buffer.from('small test weights');
let home: string;
let catalog: CatalogService;
let catalogVersion: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'shared-model-migration-'));
  catalog = new CatalogService();
  const detail = await catalog.get('chat-model', MODEL_ID);
  if (!detail || detail.manifest.kind !== 'chat-model')
    throw new Error('test catalog model missing');
  catalogVersion = detail.manifest.version;
  const originalGet = catalog.get.bind(catalog);
  vi.spyOn(catalog, 'get').mockImplementation(async (...args) => {
    const found = await originalGet(...args);
    if (!found || found.manifest.kind !== 'chat-model' || found.manifest.id !== MODEL_ID)
      return found;
    return {
      ...found,
      manifest: {
        ...found.manifest,
        llamaCpp: {
          huggingfaceRepo: 'test/model',
          filename: 'weights.gguf',
          sha256: createHash('sha256').update(WEIGHTS).digest('hex'),
          approxSizeBytes: WEIGHTS.byteLength,
        },
      },
    };
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function sourceHomes(): SharedModelSourceHome[] {
  return [{ source: 'current', label: 'This account', home }];
}

async function localModel(version = catalogVersion, weights = WEIGHTS) {
  const modelDir = join(home, 'engines', 'llama-cpp', 'models', MODEL_ID);
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, 'weights.gguf'), weights);
  const installedManifest = {
    id: MODEL_ID,
    name: 'Llama 3.2 3B',
    installedAt: '2026-08-04T00:00:00.000Z',
    weightsFilename: 'weights.gguf',
    approxSizeBytes: 18,
    catalogVersion: version,
  };
  await writeFile(join(modelDir, 'manifest.json'), JSON.stringify(installedManifest));
  const summary = {
    id: MODEL_ID,
    name: 'Llama 3.2 3B',
    approxSizeBytes: 18,
    catalogVersion: version,
  };
  const bundleSource: ModelBundleSource = {
    id: MODEL_ID,
    name: summary.name,
    modelDir,
    installedManifest,
    modelFiles: ['weights.gguf'],
    catalogVersion: version,
  };
  const owner = {
    listInstalled: vi.fn(async () => [summary]),
    resolveModel: vi.fn(async (id: string) => (id === MODEL_ID ? summary : null)),
    delete: vi.fn(async () => rm(modelDir, { recursive: true, force: true })),
    getModelBundleSource: vi.fn(async () => bundleSource),
    importModelBundle: vi.fn(async () => {}),
  };
  return { modelDir, owner };
}

function migrationManager(
  owner: Awaited<ReturnType<typeof localModel>>['owner'],
  bridge: MachineEngineBridge,
) {
  return new SharedModelMigrationManager({
    home,
    catalog,
    llamaCpp: owner as never,
    mlx: owner as never,
    ds4: owner as never,
    machineEngine: bridge,
    sourceHomes: sourceHomes(),
  });
}

function bridgeWith(proxy: MachineEngineBridge['proxy'], connected = true): MachineEngineBridge {
  return {
    isConnected: () => connected,
    isRequired: () => connected,
    proxy,
    stop: async () => {},
  };
}

describe('SharedModelMigrationManager', () => {
  it('discovers both regular and development Gezel homes without exposing arbitrary paths', () => {
    expect(defaultSourceHomes(home)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'current', home }),
        expect.objectContaining({ source: 'default', home: join(homedir(), '.gezel') }),
        expect.objectContaining({
          source: 'development',
          home: join(homedir(), '.gezel-dev'),
        }),
      ]),
    );
  });

  it('offers only local models holding the current payload while the broker is connected', async () => {
    const { owner } = await localModel();
    const connected = migrationManager(
      owner,
      bridgeWith(async () => new Response(null, { status: 500 })),
    );

    await expect(connected.listCandidates('llama-cpp')).resolves.toEqual([
      expect.objectContaining({
        source: 'current',
        engine: 'llama-cpp',
        id: MODEL_ID,
        catalogVersion,
        moving: false,
      }),
    ]);

    const disconnected = migrationManager(
      owner,
      bridgeWith(async () => new Response(null, { status: 500 }), false),
    );
    await expect(disconnected.listCandidates('llama-cpp')).resolves.toEqual([]);

    // A version difference alone is not staleness. The catalog bumps for
    // metadata edits that never touch the weights, and refusing to share a
    // model over one would strand every install after any catalog change.
    const bumped = await localModel('0.0.1');
    await expect(
      migrationManager(
        bumped.owner,
        bridgeWith(async () => new Response(null, { status: 500 })),
      ).listCandidates('llama-cpp'),
    ).resolves.toEqual([expect.objectContaining({ id: MODEL_ID, catalogVersion: '0.0.1' })]);

    // Different bytes on disk than the catalog now pins: genuinely stale, and
    // the export would fail its integrity check anyway.
    const stale = await localModel('0.0.1', Buffer.from('different weights entirely'));
    await expect(
      migrationManager(
        stale.owner,
        bridgeWith(async () => new Response(null, { status: 500 })),
      ).listCandidates('llama-cpp'),
    ).resolves.toEqual([]);
  });

  it('streams, publishes, and only then deletes the private model', async () => {
    const { owner } = await localModel();
    const phases: string[] = [];
    const proxy = vi.fn(async (request: Request) => {
      if (request.url.endsWith('/imports/scan')) {
        phases.push('scan');
        const zip = new AdmZip(Buffer.from(await request.arrayBuffer()));
        const manifest = JSON.parse(zip.readAsText('manifest.json')) as GezmodelBundleManifest;
        return Response.json(
          {
            importId: 'e1788664-6d0b-4d2a-b069-e6ad3ffb87ea',
            manifest,
            alreadyInstalled: false,
            warnings: [],
          },
          { status: 201 },
        );
      }
      phases.push('publish');
      return Response.json({ ok: true, engine: 'llama-cpp', id: MODEL_ID });
    });
    owner.delete.mockImplementation(async () => {
      phases.push('delete');
    });
    const manager = migrationManager(owner, bridgeWith(proxy));

    await expect(manager.move(request())).resolves.toEqual({
      ok: true,
      engine: 'llama-cpp',
      id: MODEL_ID,
      localRemoved: true,
    });
    expect(phases).toEqual(['scan', 'publish', 'delete']);
  });

  it('reports an active move while the transfer is still in flight', async () => {
    const { owner } = await localModel();
    let signalScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      signalScanStarted = resolve;
    });
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const proxy = vi.fn(async (incoming: Request) => {
      if (incoming.url.endsWith('/imports/scan')) {
        const zip = new AdmZip(Buffer.from(await incoming.arrayBuffer()));
        const manifest = JSON.parse(zip.readAsText('manifest.json')) as GezmodelBundleManifest;
        signalScanStarted();
        await scanGate;
        return Response.json({
          importId: 'e1788664-6d0b-4d2a-b069-e6ad3ffb87ea',
          manifest,
          alreadyInstalled: false,
          warnings: [],
        });
      }
      return Response.json({ ok: true, engine: 'llama-cpp', id: MODEL_ID });
    });
    const manager = migrationManager(owner, bridgeWith(proxy));

    const move = manager.move(request());
    await scanStarted;

    await expect(manager.listCandidates('llama-cpp')).resolves.toEqual([
      expect.objectContaining({ id: MODEL_ID, moving: true }),
    ]);
    await expect(manager.move(request())).rejects.toThrow('this model is already being moved');

    releaseScan();
    await expect(move).resolves.toMatchObject({ ok: true, id: MODEL_ID });
  });

  it('keeps the private model and cancels broker staging when publish fails', async () => {
    const { owner } = await localModel();
    const phases: string[] = [];
    const proxy = vi.fn(async (incoming: Request) => {
      if (incoming.url.endsWith('/imports/scan')) {
        phases.push('scan');
        const zip = new AdmZip(Buffer.from(await incoming.arrayBuffer()));
        const manifest = JSON.parse(zip.readAsText('manifest.json')) as GezmodelBundleManifest;
        return Response.json({
          importId: 'e1788664-6d0b-4d2a-b069-e6ad3ffb87ea',
          manifest,
          alreadyInstalled: false,
          warnings: [],
        });
      }
      if (incoming.method === 'DELETE') {
        phases.push('cancel');
        return Response.json({ ok: true });
      }
      phases.push('publish');
      return Response.json({ error: 'shared store is busy' }, { status: 503 });
    });
    const manager = migrationManager(owner, bridgeWith(proxy));

    await expect(manager.move(request())).rejects.toThrow('shared store is busy');
    expect(owner.delete).not.toHaveBeenCalled();
    expect(phases).toEqual(['scan', 'publish', 'cancel']);
  });

  it('refuses changed local weights before sending anything to the broker', async () => {
    const { modelDir, owner } = await localModel();
    await writeFile(join(modelDir, 'weights.gguf'), Buffer.from('tampered weights'));
    const proxy = vi.fn(async () => Response.json({ ok: true }));
    const manager = migrationManager(owner, bridgeWith(proxy));

    await expect(manager.move(request())).rejects.toThrow('does not match the current catalog');
    expect(proxy).not.toHaveBeenCalled();
    expect(owner.delete).not.toHaveBeenCalled();
  });
});

function request(): SharedModelMigrationRequest {
  return { source: 'current', engine: 'llama-cpp', id: MODEL_ID };
}
