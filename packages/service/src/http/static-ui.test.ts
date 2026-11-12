import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mimeTypeForPath } from './mime.js';
import {
  UI_DOCUMENT_CACHE_CONTROL,
  UI_IMMUTABLE_ASSET_CACHE_CONTROL,
  UI_STREAM_THRESHOLD_BYTES,
  ifNoneMatchHits,
  shouldServeUiShell,
  staticUiCacheControl,
  staticUiRoutes,
  uiFileEtag,
} from './static-ui.js';

describe('the static UI route', () => {
  let uiDir: string;
  beforeAll(async () => {
    uiDir = await mkdtemp(join(tmpdir(), 'gezel-static-ui-'));
    await mkdir(join(uiDir, 'assets'));
    await mkdir(join(uiDir, 'harper'));
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Gezel</title>');
    await writeFile(join(uiDir, 'assets', 'index-AbC123.js'), 'export {};');
    await writeFile(
      join(uiDir, 'harper', 'harper_wasm_bg.wasm'),
      Buffer.alloc(UI_STREAM_THRESHOLD_BYTES + 10, 1),
    );
  });
  afterAll(async () => {
    await rm(uiDir, { recursive: true, force: true });
  });

  it('answers a revalidation of an unchanged file with 304', async () => {
    const app = staticUiRoutes(uiDir);
    const first = await app.request('/');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe(UI_DOCUMENT_CACHE_CONTROL);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const again = await app.request('/', { headers: { 'If-None-Match': etag! } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    // A client route gets the same shell, with the same validator.
    const route = await app.request('/projects/gezel', { headers: { 'If-None-Match': etag! } });
    expect(route.status).toBe(304);
  });

  it('caches hashed assets forever without a validator, and 404s missing ones', async () => {
    const app = staticUiRoutes(uiDir);
    const asset = await app.request('/assets/index-AbC123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe(UI_IMMUTABLE_ASSET_CACHE_CONTROL);
    expect(asset.headers.get('etag')).toBeNull();
    expect((await app.request('/assets/index-gone.js')).status).toBe(404);
  });

  it('streams a large file whole, with its length', async () => {
    const app = staticUiRoutes(uiDir);
    const res = await app.request('/harper/harper_wasm_bg.wasm');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/wasm');
    expect(res.headers.get('content-length')).toBe(String(UI_STREAM_THRESHOLD_BYTES + 10));
    expect((await res.arrayBuffer()).byteLength).toBe(UI_STREAM_THRESHOLD_BYTES + 10);
  });
});

describe('static UI responses', () => {
  it('revalidates the HTML shell and caches Vite assets immutably', () => {
    expect(staticUiCacheControl('index.html')).toBe(UI_DOCUMENT_CACHE_CONTROL);
    expect(staticUiCacheControl('assets/TerminalCodeEditor-D7EVHAoe.js')).toBe(
      UI_IMMUTABLE_ASSET_CACHE_CONTROL,
    );
    // The startup page's hashed chunks too; its unhashed entry revalidates.
    expect(staticUiCacheControl('startup/assets/documents-BjL0SG2r.js')).toBe(
      UI_IMMUTABLE_ASSET_CACHE_CONTROL,
    );
    expect(staticUiCacheControl('startup/startup.js')).toBe(UI_DOCUMENT_CACHE_CONTROL);
    expect(staticUiCacheControl('harper/harper_wasm_bg.wasm')).toBe(UI_DOCUMENT_CACHE_CONTROL);
  });

  it('gives revalidated files a validator that changes with the file', () => {
    const etag = uiFileEtag({ size: 15_848_134, mtimeMs: 1_789_000_000_123.4 });
    expect(etag).toBe(uiFileEtag({ size: 15_848_134, mtimeMs: 1_789_000_000_123.9 }));
    expect(etag).not.toBe(uiFileEtag({ size: 15_848_134, mtimeMs: 1_789_000_001_000 }));
    expect(etag).not.toBe(uiFileEtag({ size: 15_848_135, mtimeMs: 1_789_000_000_123 }));
    expect(ifNoneMatchHits(etag, etag)).toBe(true);
    expect(ifNoneMatchHits(`"other", ${etag.replace('W/', '')}`, etag)).toBe(true);
    expect(ifNoneMatchHits('*', etag)).toBe(true);
    expect(ifNoneMatchHits('"other"', etag)).toBe(false);
    expect(ifNoneMatchHits(undefined, etag)).toBe(false);
  });

  it('uses the SPA fallback for client routes but not missing files', () => {
    expect(shouldServeUiShell('projects/gezel')).toBe(true);
    expect(shouldServeUiShell('assets/TerminalCodeEditor-old.js')).toBe(false);
    expect(shouldServeUiShell('assets/missing-extensionless-chunk')).toBe(false);
    expect(shouldServeUiShell('favicon.svg')).toBe(false);
  });

  it('serves the proofing engine as WebAssembly, and 404s a missing one', () => {
    // Both binaries ship: the full engine finds its slim sibling by
    // substituting the filename in its own URL, so they must sit side by
    // side under the same directory with their real names.
    for (const name of ['harper_wasm_bg.wasm', 'harper_wasm_slim_bg.wasm']) {
      expect(mimeTypeForPath(`harper/${name}`)).toBe('application/wasm');
      // A missing binary must fall through to a clean 404 rather than the
      // SPA shell. `200 text/html` for a .wasm path surfaces inside the
      // worker as a confusing WASM compile error instead of "not found".
      expect(shouldServeUiShell(`harper/${name}`)).toBe(false);
    }
  });
});
