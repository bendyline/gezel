import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Stream a file through SHA-256 without ever buffering its payload. */
export async function hashFileStreaming(
  path: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hasher = createHash('sha256');
  let sizeBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sizeBytes += bytes.byteLength;
      if (sizeBytes > maxBytes) {
        stream.destroy(new Error(`file exceeds ${maxBytes} byte limit`));
        return;
      }
      hasher.update(bytes);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hasher.digest('hex'), sizeBytes };
}
