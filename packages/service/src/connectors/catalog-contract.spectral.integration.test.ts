import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ConnectorTypeManifest,
  ConnectorTypeManifestSchema,
  ConnectorTypeTestSpecSchema,
  type SpectralComponentSource,
  connectorSourceProblems,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import {
  CatalogService,
  fetchPinnedNpmTarball,
  verifyTarballSha256,
} from '@bendyline/gezel-catalog';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { SpectralReplay } from './drivers/spectral-component.js';
import { ConnectorManager } from './manager.js';
import { ComponentStore, componentFolderName } from './spectral/component-store.js';
import { startFakeRegistry } from './testing/fake-npm-registry.js';
import { assertCorpusInvariants, readCorpus } from './testing/harness.js';
import { RECORD_FILE_RE, sha8 } from './writer.js';

/**
 * Spectral types built on a published component, drafted here until gilde
 * carries them (`__fixtures__/contract-provisional/spectral/<type>@<v>.*`).
 * Each case binds through the real manager, which installs the pinned
 * component through the real store, and syncs through runner v2 in the
 * sandbox, answering from the recordings with the network denied.
 *
 * The component itself is the published tarball, checked against its pin.
 * It is read from `GEZEL_COMPONENT_CACHE` when set, else fetched from npm;
 * offline, a case skips and says why, except under CI, where it fails.
 */

const require = createRequire(import.meta.url);
const built = existsSync(require.resolve('@bendyline/gezel-connectors-spectral/run'));
const DIR = join(import.meta.dirname, '__fixtures__', 'contract-provisional', 'spectral');
const CACHE = process.env.GEZEL_COMPONENT_CACHE ?? join(tmpdir(), 'gezel-component-cache');

interface Draft {
  key: string;
  manifest: ConnectorTypeManifest;
  spec: ReturnType<typeof ConnectorTypeTestSpecSchema.parse>;
}

const drafts: Draft[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.manifest.json'))
  .map((f) => {
    const key = f.replace(/\.manifest\.json$/, '');
    return {
      key,
      manifest: ConnectorTypeManifestSchema.parse(JSON.parse(readFileSync(join(DIR, f), 'utf8'))),
      spec: ConnectorTypeTestSpecSchema.parse(
        JSON.parse(readFileSync(join(DIR, `${key}.test.json`), 'utf8')),
      ),
    };
  });

/** The published tarball for a pin, verified, from the cache or npm. */
async function tarballFor(pin: SpectralComponentSource['package']): Promise<string | Error> {
  await mkdir(CACHE, { recursive: true });
  const path = join(CACHE, `${componentFolderName(pin)}.tgz`);
  if (existsSync(path) && (await verifyTarballSha256(path)) === pin.sha256) return path;
  const temp = join(await mkdtemp(join(tmpdir(), 'gezel-component-fetch-')), 'package.tgz');
  try {
    const sha = await fetchPinnedNpmTarball({
      packageName: pin.name,
      version: pin.version,
      dest: temp,
    });
    if (sha !== pin.sha256)
      return new Error(`the registry's ${pin.name}@${pin.version} does not match its pin`);
    await copyFile(temp, path);
    return path;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.map((h) => rm(h, { recursive: true, force: true })));
});

describe.runIf(built)('Spectral component contracts', () => {
  for (const draft of drafts) {
    it(`${draft.key}: the drafted source is well formed`, () => {
      expect(connectorSourceProblems('spectral', draft.manifest.source)).toEqual([]);
    });

    for (const c of draft.spec.cases) {
      it(`${draft.key}: ${c.id}`, async (ctx) => {
        const pin = (draft.manifest.source as unknown as SpectralComponentSource).package;
        const tarball = await tarballFor(pin);
        if (tarball instanceof Error) {
          if (process.env.CI) throw tarball;
          ctx.skip(`the published component is not available offline: ${tarball.message}`);
          return;
        }
        const registry = await startFakeRegistry([
          { name: pin.name, version: pin.version, tarball: await copyAside(tarball) },
        ]);
        try {
          const home = await mkdtemp(join(tmpdir(), 'gezel-contract-'));
          homes.push(home);
          const store = new Store({ home });
          await store.ensureLayout();
          await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
          const project = await store.createProject({ name: 'Contract' });
          const secrets = new FileSecretStore(home);
          const real = new CatalogService();
          const catalog = {
            get: async (kind: string, id: string, source?: string, version?: string) =>
              id === draft.manifest.id
                ? { manifest: draft.manifest, sourceId: 'bundled' }
                : real.get(kind as never, id, source, version),
            listVersions: async () => [{ version: draft.manifest.version }],
          } as unknown as CatalogService;
          const replay = new SpectralReplay(c.exchanges);
          const connectors = new ConnectorManager({
            store,
            secrets,
            catalog,
            components: new ComponentStore({ home, registry: registry.url }),
            spectralReplay: replay,
          });
          const binding = await connectors.bind(project, {
            type: draft.manifest.id,
            config: c.config,
            ...(c.credential === 'placeholder' ? { credential: 'contract-placeholder-token' } : {}),
          });
          for (let pass = 0; pass < c.passes; pass++) {
            const r = await connectors.syncBinding(project, binding.id);
            expect(r.error, `pass ${pass + 1} failed`).toBeUndefined();
            expect(r.errors, `pass ${pass + 1} had record errors`).toBe(0);
          }
          expect(replay.unused(), 'answers the type never asked for').toBe(0);

          const artifacts = store.projectArtifactsDir(project.id);
          const corpusDir = (await store.getProject(project.id))!.connectors!.find(
            (b) => b.id === binding.id,
          )!.corpusDir!;
          if (c.expect.records) {
            const corpus = await readCorpus(artifacts, corpusDir);
            const byHash = new Map(
              corpus.map((r) => [RECORD_FILE_RE.exec(r.path.split('/').at(-1)!)?.[2] ?? '', r]),
            );
            expect(corpus).toHaveLength(c.expect.records.length);
            for (const want of c.expect.records) {
              const got = byHash.get(sha8(want.id));
              expect(got, `record ${want.id}`).toBeDefined();
              for (const [k, v] of Object.entries(want.frontmatter ?? {})) {
                expect(got!.frontmatter[k], `${want.id} ${k}`).toBe(v);
              }
              if (want.bodyIncludes) expect(got!.body).toContain(want.bodyIncludes);
            }
            if (corpus.length > 0) await assertCorpusInvariants(artifacts, corpusDir);
          }
        } finally {
          await registry.close();
        }
      }, 120_000);
    }
  }
});

/** The fake registry removes its tarballs' folders on close; keep the cache. */
async function copyAside(path: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-fake-npm-'));
  const copy = join(dir, 'package.tgz');
  await copyFile(path, copy);
  return copy;
}
