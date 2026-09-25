import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PRODUCT_FILE_BYTES,
  type ProductFilePlugin,
  createNativeProductFiles,
} from './product-files.js';

function fixture() {
  const plugin: ProductFilePlugin = {
    readProductFile: vi.fn(async () => ({ data: 'AP8BAg==' })),
    writeProductFile: vi.fn(async () => {}),
    listProductFiles: vi.fn(async () => ({
      entries: [{ name: 'file', isDirectory: false, size: 4, mtime: 10 }],
    })),
    mkdirProductDirectory: vi.fn(async () => {}),
    removeProductPath: vi.fn(async () => {}),
    renameProductPath: vi.fn(async () => {}),
  };
  return { plugin, files: createNativeProductFiles(plugin) };
}

describe('native product file boundary', () => {
  it('preserves arbitrary bytes and direct directory entries', async () => {
    const { plugin, files } = fixture();
    const bytes = new Uint8Array([0, 255, 1, 2]);
    await files.write('documents/file', bytes);
    expect(plugin.writeProductFile).toHaveBeenCalledWith({
      path: 'documents/file',
      data: 'AP8BAg==',
    });
    expect(await files.read('documents/file')).toEqual(bytes);
    expect(await files.list('documents')).toEqual([
      { name: 'file', isDirectory: false, size: 4, mtime: 10 },
    ]);
    await files.rename('.transactions/draft', 'projects/new');
    expect(plugin.renameProductPath).toHaveBeenCalledWith({
      from: '.transactions/draft',
      to: 'projects/new',
    });
  });

  it('rejects escapes and root deletion before crossing the native bridge', async () => {
    const { plugin, files } = fixture();
    for (const path of [
      '',
      '../state.json',
      '/absolute',
      'a/../x',
      'a//x',
      './x',
      'a\\x',
      'a\0x',
    ]) {
      await expect(files.write(path, new Uint8Array())).rejects.toThrow();
      await expect(files.remove(path)).rejects.toThrow();
    }
    await expect(files.rename('documents', 'documents/nested')).rejects.toThrow();
    expect(plugin.writeProductFile).not.toHaveBeenCalled();
    expect(plugin.removeProductPath).not.toHaveBeenCalled();
    await files.list('');
    await files.mkdir('');
  });

  it('rejects malformed native responses and oversized writes', async () => {
    const { plugin, files } = fixture();
    vi.mocked(plugin.readProductFile).mockResolvedValue({ data: '???' });
    await expect(files.read('bad')).rejects.toThrow();
    vi.mocked(plugin.listProductFiles).mockResolvedValue({
      entries: [{ name: '../escape', isDirectory: false, size: 0, mtime: 0 }],
    });
    await expect(files.list('documents')).rejects.toThrow();
    await expect(files.write('large', new Uint8Array(MAX_PRODUCT_FILE_BYTES + 1))).rejects.toThrow(
      '16 MiB',
    );
    expect(plugin.writeProductFile).not.toHaveBeenCalled();
  });
});
