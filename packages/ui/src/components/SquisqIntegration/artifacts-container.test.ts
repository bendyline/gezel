import { GezelApiError, type GezelClient } from '@bendyline/gezel-client';
import { describe, expect, it, vi } from 'vitest';
import { createArtifactsContentContainer } from './artifacts-container.js';

function fakeClient(overrides: Record<string, unknown> = {}): GezelClient {
  return {
    listProjectArtifacts: vi.fn().mockResolvedValue({ files: [] }),
    readProjectArtifact: vi.fn(),
    fetchProjectArtifactBlob: vi.fn(),
    writeProjectArtifact: vi.fn(),
    writeProjectArtifactBinary: vi.fn(),
    deleteProjectArtifact: vi.fn(),
    ...overrides,
  } as unknown as GezelClient;
}

describe('project artifact document containers', () => {
  it('lists and writes inside only the active Markdown companion', async () => {
    const listProjectArtifacts = vi.fn().mockResolvedValue({
      files: [
        { path: 'reports/brief_files/hero.png', isDirectory: false },
        { path: 'reports/other_files/leak.png', isDirectory: false },
      ],
    });
    const writeProjectArtifactBinary = vi.fn().mockResolvedValue({ ok: true });
    const container = createArtifactsContentContainer({
      projectId: 'p1',
      root: 'reports/brief_files',
      referencePrefix: 'brief_files',
      client: fakeClient({ listProjectArtifacts, writeProjectArtifactBinary }),
    });

    await expect(container.listFiles()).resolves.toEqual([
      { path: 'hero.png', mimeType: 'image/png', size: 0 },
    ]);
    expect(listProjectArtifacts).toHaveBeenCalledWith('p1', 'reports/brief_files', true);

    const bytes = new Uint8Array([1, 2]);
    await container.writeFile('brief_files/photo.png', bytes, 'image/png');
    expect(writeProjectArtifactBinary).toHaveBeenCalledWith(
      'p1',
      'reports/brief_files/photo.png',
      bytes,
      'image/png',
    );
  });

  it('turns only typed 404s into missing files', async () => {
    const missing = createArtifactsContentContainer({
      projectId: 'p1',
      root: 'brief_files',
      client: fakeClient({
        readProjectArtifact: vi.fn().mockRejectedValue(new GezelApiError('missing', 404)),
      }),
    });
    await expect(missing.readFile('notes.md')).resolves.toBeNull();

    const denied = createArtifactsContentContainer({
      projectId: 'p1',
      root: 'brief_files',
      client: fakeClient({
        readProjectArtifact: vi.fn().mockRejectedValue(new GezelApiError('denied', 403)),
      }),
    });
    await expect(denied.readFile('notes.md')).rejects.toMatchObject({ status: 403 });
  });

  it('ignores only typed 404s when removing files', async () => {
    const missing = createArtifactsContentContainer({
      projectId: 'p1',
      root: 'brief_files',
      client: fakeClient({
        deleteProjectArtifact: vi.fn().mockRejectedValue(new GezelApiError('missing', 404)),
      }),
    });
    await expect(missing.removeFile('hero.png')).resolves.toBeUndefined();

    const denied = createArtifactsContentContainer({
      projectId: 'p1',
      root: 'brief_files',
      client: fakeClient({
        deleteProjectArtifact: vi.fn().mockRejectedValue(new GezelApiError('denied', 403)),
      }),
    });
    await expect(denied.removeFile('hero.png')).rejects.toMatchObject({ status: 403 });
  });
});
