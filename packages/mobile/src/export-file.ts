export interface ExportedFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}
export interface ExportFilePlugin {
  beginExport(options: { name: string; mimeType: string; sizeBytes: number }): Promise<{
    token: string;
  }>;
  appendExport(options: { token: string; offset: number; data: string }): Promise<void>;
  saveExport(options: { token: string }): Promise<void>;
  cancelExport(options: { token: string }): Promise<void>;
}
export function validateExport(file: ExportedFile) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,150}$/.test(file.name) ||
    !file.name.endsWith('.zip') ||
    file.mimeType !== 'application/zip'
  )
    throw new Error('Choose a valid ZIP export filename');
  if (
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.length < 1 ||
    file.bytes.length > 72 * 1024 * 1024
  )
    throw new Error('ZIP exports are limited to 72 MiB');
}
export async function saveNativeExport(plugin: ExportFilePlugin, file: ExportedFile) {
  validateExport(file);
  const { token } = await plugin.beginExport({
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.bytes.length,
  });
  try {
    for (let offset = 0; offset < file.bytes.length; offset += 256 * 1024) {
      const bytes = file.bytes.subarray(offset, offset + 256 * 1024);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192)
        binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      await plugin.appendExport({ token, offset, data: btoa(binary) });
    }
    await plugin.saveExport({ token });
  } finally {
    await plugin.cancelExport({ token }).catch(() => {});
  }
}
export async function saveBrowserExport(file: ExportedFile) {
  validateExport(file);
  const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
