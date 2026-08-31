/**
 * Assets the service tarball must carry, and the native-release pin.
 *
 * `packages/service/tsup.config.ts` stages two trees into `dist/` in an
 * `onSuccess` hook rather than through the TypeScript build:
 *
 *   dist/ui/               the web UI, so `gezel start --web` works from a
 *                          Node-only npm install with nothing else fetched
 *   dist/handboek-content/ the end-user handbook the daemon serves
 *
 * A hook is a silent-failure surface: if it stops running, the build still
 * succeeds, the tarball still publishes, and the failure only shows up as a
 * blank page for a user who installed from npm.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_ENGINE_RELEASE,
  SHA256SUMS_DIGEST,
  isPlaceholderDigest,
} from '../../packages/service/src/engines/native-manifest';
import {
  SERVICE_WORKER_ENTRIES,
  type ServiceWorkerEntry,
  findServiceWorkerEntry,
} from '../../packages/service/src/utils/service-worker-entry';
import { loadPublishedPackages } from './_packages';

const service = loadPublishedPackages().find((p) => p.dir === 'service')!;
const workerNames = Object.keys(SERVICE_WORKER_ENTRIES) as ServiceWorkerEntry[];

describe('service bundled assets', () => {
  it('stages the web UI into dist/ui', () => {
    expect(existsSync(resolve(service.dist, 'ui/index.html'))).toBe(true);
  });

  it('stages the handboek content', () => {
    expect(existsSync(resolve(service.dist, 'handboek-content'))).toBe(true);
  });

  it('stages BOTH harper proofing binaries beside the UI', () => {
    // Spelling/grammar is local-first like everything else here: squisq
    // reaches harper.js only through a dynamic import and there is no CDN
    // fallback, so the engine has to be on disk or the feature silently
    // hangs on "Proofing...". Both binaries are required — the full engine
    // finds its slim sibling by substituting the filename in its own URL,
    // so shipping one without the other 404s inside the worker.
    for (const f of ['harper_wasm_bg.wasm', 'harper_wasm_slim_bg.wasm', 'LICENSE.txt']) {
      expect(existsSync(resolve(service.dist, 'ui/harper', f)), f).toBe(true);
    }
  });

  it('does not ship harper twice', () => {
    // `harper.js/binary` locates the engine with `new URL(..., import.meta.url)`,
    // which Vite would emit as a second, content-hashed 15.8 MB copy under
    // assets/ — one that cannot even work, since the slim-sibling filename
    // substitution finds no match in a hashed name. The UI build stubs that
    // entry out (packages/ui/scripts/vite-harper-wasm.ts); this guards it.
    const assets = resolve(service.dist, 'ui/assets');
    const strays = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.wasm')) : [];
    expect(strays).toEqual([]);
  });

  it('does not ship the browser ffmpeg runtime', () => {
    expect(existsSync(resolve(service.dist, 'ui/ffmpeg-core/ffmpeg-core.js'))).toBe(false);
    expect(existsSync(resolve(service.dist, 'ui/ffmpeg-core/ffmpeg-core.wasm'))).toBe(false);
  });

  it('stages the MLX sidecar python tree, including its hard imports', () => {
    // gezel_mlx_server.py does `import spec_decode` (and cache_seed etc.)
    // at module top, so a dropped sibling kills the whole MLX engine at
    // boot — but only for people who installed from npm, the same silent
    // failure mode as the handboek hook.
    for (const f of [
      'gezel_mlx_server.py',
      'spec_decode.py',
      'cache_seed.py',
      'cache_persist.py',
    ]) {
      expect(existsSync(resolve(service.dist, 'providers/mlx/python', f)), f).toBe(true);
    }
  });
});

/**
 * Worker threads the daemon spawns by path, resolved the way the daemon
 * resolves them.
 *
 * These are separate tsup entries, so `existsSync` on the emitted files only
 * proves the build wrote them — not that the running daemon can find them. The
 * two questions have had different answers: through v1.26219.45 all four
 * workers were emitted correctly and none were reachable, because each caller
 * resolved candidates relative to `import.meta.url` assuming that meant
 * `dist/`. It does in embedded mode. Every spawned and packaged install enters
 * through `dist/bin/gezeld.js`, where it means `dist/bin/`, so every probe
 * missed and the daemon silently ran without workers: no enhanced GGUF
 * metadata in the model UI, embeddings back on the event loop, indexing and
 * document conversion degraded. Dev and CI never saw it.
 *
 * This is the third instance of the same class in this repo — see the
 * `findHandboekContent()` note in CLAUDE.md, which probed a path correct for
 * `dist/index.js` and wrong for the one entry point an npm install runs. So
 * assert reachability from the daemon entrypoint specifically, and drive the
 * list from the resolver's own table: a fifth worker is covered the moment it
 * is registered, without touching this file.
 */
describe('service worker entrypoints', () => {
  const daemonEntry = pathToFileURL(resolve(service.dist, 'bin/gezeld.js')).href;
  const embeddedEntry = pathToFileURL(resolve(service.dist, 'index.js')).href;

  it('emits every registered worker', () => {
    expect(workerNames.length).toBeGreaterThan(0);
    for (const name of workerNames) {
      const built = resolve(service.dist, SERVICE_WORKER_ENTRIES[name].built);
      expect(existsSync(built), `${name}: tsup did not emit ${built}`).toBe(true);
    }
  });

  // The regression that shipped. Resolution from `dist/bin/gezeld.js` is the
  // path every packaged install and every `gezel start` takes.
  it.each(workerNames)('resolves %s from the daemon entrypoint', (name) => {
    const resolved = findServiceWorkerEntry(daemonEntry, name);
    expect(
      resolved,
      `${name} is unreachable from dist/bin/gezeld.js — the daemon would run without it`,
    ).not.toBeNull();
    expect(existsSync(resolved!)).toBe(true);
  });

  it.each(workerNames)('resolves %s from the embedded entrypoint', (name) => {
    expect(findServiceWorkerEntry(embeddedEntry, name)).not.toBeNull();
  });

  // Both entrypoints must land on the same file. Diverging here would mean
  // embedded and packaged runs execute different worker code.
  it.each(workerNames)('resolves %s identically from both entrypoints', (name) => {
    expect(findServiceWorkerEntry(daemonEntry, name)).toBe(
      findServiceWorkerEntry(embeddedEntry, name),
    );
  });
});

describe('native engine release pin', () => {
  it('points at a real release, not the placeholder', () => {
    // A placeholder digest makes `isEnginePinned()` false, which silently
    // disables on-device engine auto-download for everyone who installed
    // from npm — they have no bundled binaries and no repo checkout to fall
    // back to. Re-pin with `node scripts/pin-native-release.mjs --latest`.
    expect(isPlaceholderDigest(SHA256SUMS_DIGEST)).toBe(false);
    expect(NATIVE_ENGINE_RELEASE).not.toBe('0.0.0');
    expect(NATIVE_ENGINE_RELEASE).toMatch(/^\d+\.\d+\.\d+/);
    expect(SHA256SUMS_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });
});
