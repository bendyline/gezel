/**
 * The smallest GGUF a header reader will accept, for tests that care about
 * one metadata key rather than the parser itself. The full-coverage builder
 * (arrays, tensors, version handling) lives in `gguf-metadata.test.ts`.
 */

import { writeFileSync } from 'node:fs';

export function writeSyntheticGguf(
  path: string,
  opts: { fileType?: number; architecture?: string } = {},
): void {
  const parts: Buffer[] = [Buffer.from('GGUF', 'ascii'), u32(3), u64(0n)];
  const entries: Buffer[] = [];
  if (opts.architecture !== undefined) {
    entries.push(ggufString('general.architecture'), u32(8), ggufString(opts.architecture));
  }
  if (opts.fileType !== undefined) {
    entries.push(ggufString('general.file_type'), u32(4), u32(opts.fileType));
  }
  const count = (opts.architecture !== undefined ? 1 : 0) + (opts.fileType !== undefined ? 1 : 0);
  parts.push(u64(BigInt(count)), ...entries);
  writeFileSync(path, Buffer.concat(parts));
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

function ggufString(s: string): Buffer {
  const utf8 = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(8 + utf8.byteLength);
  out.writeBigUInt64LE(BigInt(utf8.byteLength), 0);
  utf8.copy(out, 8);
  return out;
}
