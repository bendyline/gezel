import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';

const bundleMocks = vi.hoisted(() => ({
  scanUpload: vi.fn(),
  cancelImport: vi.fn(async () => {}),
}));

vi.mock('../../models/gezmodel.js', () => ({
  GezmodelManager: class {
    scanUpload = bundleMocks.scanUpload;
    cancelImport = bundleMocks.cancelImport;
  },
}));

import { modelBundleRoutes } from './model-bundles.js';

const IMPORT_ID = '11111111-1111-4111-8111-111111111111';

function app() {
  const root = new Hono();
  root.route('/api/model-bundles', modelBundleRoutes({} as ServiceContext));
  return root;
}

beforeEach(() => {
  bundleMocks.scanUpload.mockReset();
  bundleMocks.cancelImport.mockClear();
});

describe('model bundle scan jobs', () => {
  it('releases the upload request, then serves progress and the completed review', async () => {
    let finishScan!: (review: unknown) => void;
    bundleMocks.scanUpload.mockImplementation(
      (_stream: unknown, options: import('../../models/gezmodel.js').GezmodelScanOptions) => {
        options.onProgress?.({ phase: 'verifying', bytesCompleted: 40, bytesTotal: 100 });
        options.onUploadComplete?.();
        return new Promise((resolve) => {
          finishScan = resolve;
        });
      },
    );
    const routes = app();
    const accepted = await routes.request('/api/model-bundles/imports/scan', {
      method: 'POST',
      headers: {
        Prefer: 'respond-async',
        'X-Gezel-Import-Id': IMPORT_ID,
        'X-Gezel-Upload-Bytes': '100',
      },
      body: new Uint8Array([1]),
    });

    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('Preference-Applied')).toBe('respond-async');
    await expect(accepted.json()).resolves.toEqual({ importId: IMPORT_ID });
    const active = await routes.request(`/api/model-bundles/imports/${IMPORT_ID}/progress`);
    await expect(active.json()).resolves.toEqual({
      status: 'active',
      progress: { phase: 'verifying', bytesCompleted: 40, bytesTotal: 100 },
    });

    const review = { importId: IMPORT_ID, manifest: { engine: 'mlx' } };
    finishScan(review);
    await vi.waitFor(async () => {
      const completed = await routes.request(`/api/model-bundles/imports/${IMPORT_ID}/progress`);
      expect(await completed.json()).toEqual({ status: 'complete', review });
    });
    expect((await routes.request(`/api/model-bundles/imports/${IMPORT_ID}/progress`)).status).toBe(
      404,
    );
  });

  it('aborts an active asynchronous scan', async () => {
    let scanSignal: AbortSignal | undefined;
    bundleMocks.scanUpload.mockImplementation(
      (_stream: unknown, options: import('../../models/gezmodel.js').GezmodelScanOptions) => {
        scanSignal = options.signal;
        options.onUploadComplete?.();
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    );
    const routes = app();
    await routes.request('/api/model-bundles/imports/scan', {
      method: 'POST',
      headers: { Prefer: 'respond-async', 'X-Gezel-Import-Id': IMPORT_ID },
      body: new Uint8Array([1]),
    });

    const canceled = await routes.request(`/api/model-bundles/imports/${IMPORT_ID}`, {
      method: 'DELETE',
    });

    expect(canceled.status).toBe(200);
    expect(scanSignal?.aborted).toBe(true);
    expect(bundleMocks.cancelImport).toHaveBeenCalledWith(IMPORT_ID);
  });
});
