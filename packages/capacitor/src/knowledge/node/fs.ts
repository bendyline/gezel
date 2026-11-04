// The two node:fs calls the catalog reader makes (manifest and asset reads), over the worker's files.
import type { RawFiles } from '../files.js';

let files: RawFiles | undefined;
export function configureFs(value: RawFiles): void {
  files = value;
}
const store = () => {
  if (!files) throw new Error('Catalog files are not configured');
  return files;
};
export function statSync(path: string) {
  const size = store().size(path);
  return { size, isFile: () => true, isDirectory: () => false };
}
export function readFileSync(path: string, encoding?: string) {
  const bytes = store().read(path, 0, store().size(path));
  return encoding ? new TextDecoder().decode(bytes) : bytes;
}
