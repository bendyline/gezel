import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { ServiceContext } from '../context.js';
import { documentMediaExportRoutes } from './document-media-export.js';

function testContext(store: Partial<Store>): ServiceContext {
  return {
    home: '/tmp/gezel-document-media-export-test',
    store,
  } as unknown as ServiceContext;
}

describe('documentMediaExportRoutes', () => {
  it('renders the current markdown with Store-backed sidecar access', async () => {
    const readDocumentBinary = vi.fn(async (path: string) =>
      path === 'notes/hero.png' ? { data: Buffer.from('hero-bytes'), mimeType: 'image/png' } : null,
    );
    const renderDocToMp4 = vi.fn(async (_doc, container, options) => {
      const image = await container.readFile('hero.png');
      expect(Buffer.from(image ?? new ArrayBuffer(0)).toString()).toBe('hero-bytes');
      await writeFile(options.outputPath, 'native-mp4');
    });
    const app = documentMediaExportRoutes(
      testContext({
        readDocumentBinary,
        listDocumentsRecursive: vi.fn(async () => []),
      }),
      async () => ({
        renderDocToMp4,
        renderDocToGif: vi.fn(),
      }),
      async (_home, task) => task(),
    );

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Current editor text\n\n![](hero.png)',
        selectedFile: 'notes/brief.md',
        format: 'mp4',
        source: { kind: 'documents' },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-disposition')).toContain('brief.mp4');
    expect(await response.text()).toBe('native-mp4');
    expect(readDocumentBinary).toHaveBeenCalledWith('notes/hero.png');
    expect(renderDocToMp4).toHaveBeenCalledOnce();
  });

  it('surfaces an actionable missing-ffmpeg error', async () => {
    const app = documentMediaExportRoutes(
      testContext({
        readDocumentBinary: vi.fn(async () => null),
        listDocumentsRecursive: vi.fn(async () => []),
      }),
      async () => ({
        renderDocToMp4: vi.fn(async () => {
          throw new Error('ffmpeg is required but not found in PATH.');
        }),
        renderDocToGif: vi.fn(),
      }),
      async (_home, task) => task(),
    );

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Current editor text',
        selectedFile: 'brief.md',
        format: 'mp4',
        source: { kind: 'documents' },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'ffmpeg is required but not found in PATH.',
    });
  });
});
