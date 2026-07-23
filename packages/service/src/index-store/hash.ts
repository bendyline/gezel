import { createHash } from 'node:crypto';

/** Content hash used as the change gate + dedup key across the index. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
