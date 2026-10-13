import { execFile } from 'node:child_process';
import { truncate, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

/**
 * Write a file that reports its full size but allocates nothing on disk, as a
 * cloud placeholder does. Extending an empty file leaves it sparse on POSIX
 * filesystems, but NTFS allocates the extension unless the file is flagged
 * sparse first, so on Windows the fixture was an ordinary local file.
 */
export async function writeCloudPlaceholder(path: string, size: number): Promise<void> {
  await writeFile(path, '');
  if (process.platform === 'win32') {
    await promisify(execFile)('fsutil', ['sparse', 'setflag', path]);
  }
  await truncate(path, size);
}
