// Document bodies are Brotli-compressed; the worker has no node:zlib.
// @ts-expect-error brotli ships no types
import decompress from 'brotli/decompress.js';

export function brotliDecompressSync(
  input: Uint8Array,
  options: { maxOutputLength?: number } = {},
): Uint8Array {
  const output = decompress(input) as Uint8Array | null;
  if (!output) throw new Error('Invalid Brotli data');
  if (options.maxOutputLength !== undefined && output.byteLength > options.maxOutputLength)
    throw new RangeError('Decompressed document exceeds its limit');
  return output;
}
