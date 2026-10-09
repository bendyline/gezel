import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Content hash used as the change gate + dedup key across the index. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The same hash over a file read in a stream — for media too large to buffer. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
