import { describe, expect, it, vi } from 'vitest';
import { type ExportFilePlugin, saveNativeExport } from './export-file.js';
function fixture() {
  return {
    beginExport: vi.fn(async () => ({ token: 'opaque' })),
    appendExport: vi.fn<ExportFilePlugin['appendExport']>(async () => {}),
    saveExport: vi.fn(async () => {}),
    cancelExport: vi.fn(async () => {}),
  };
}
describe('native ZIP export transport', () => {
  it('bounds bridge messages, preserves bytes and presents Files only when staging completes', async () => {
    const plugin = fixture();
    const bytes = Uint8Array.from({ length: 600_000 }, (_, index) => index % 256);
    const reconstructed: number[] = [];
    plugin.appendExport.mockImplementation(async (chunk) => {
      const value = chunk as { token: string; offset: number; data: string };
      expect(value.token).toBe('opaque');
      expect(value.offset).toBe(reconstructed.length);
      const binary = atob(value.data);
      expect(binary.length).toBeLessThanOrEqual(256 * 1024);
      for (const char of binary) reconstructed.push(char.charCodeAt(0));
    });
    await saveNativeExport(plugin, {
      name: 'gezel-backup.zip',
      mimeType: 'application/zip',
      bytes,
    });
    expect(new Uint8Array(reconstructed)).toEqual(bytes);
    expect(plugin.appendExport).toHaveBeenCalledTimes(3);
    expect(plugin.saveExport).toHaveBeenCalledExactlyOnceWith({ token: 'opaque' });
    expect(plugin.cancelExport).toHaveBeenCalledExactlyOnceWith({ token: 'opaque' });
  });
  it('cleans incomplete staging after failure without opening the picker or hiding the error', async () => {
    const plugin = fixture();
    plugin.appendExport.mockRejectedValueOnce(new Error('Storage full'));
    plugin.cancelExport.mockRejectedValueOnce(new Error('Cleanup failed'));
    await expect(
      saveNativeExport(plugin, {
        name: 'backup.zip',
        mimeType: 'application/zip',
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow('Storage full');
    expect(plugin.saveExport).not.toHaveBeenCalled();
    expect(plugin.cancelExport).toHaveBeenCalledOnce();
  });
  it('rejects unsafe names and oversize archives before native I/O', async () => {
    const plugin = fixture();
    for (const name of ['../backup.zip', '/backup.zip', 'backup.zip/else', 'file.exe'])
      await expect(
        saveNativeExport(plugin, { name, mimeType: 'application/zip', bytes: new Uint8Array([1]) }),
      ).rejects.toThrow('filename');
    await expect(
      saveNativeExport(plugin, {
        name: 'backup.zip',
        mimeType: 'application/zip',
        bytes: new Uint8Array(72 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow('72 MiB');
    expect(plugin.beginExport).not.toHaveBeenCalled();
  });
});
