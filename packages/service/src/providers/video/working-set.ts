/**
 * Memory the video engine needs for one installed model, priced from the
 * weights' own safetensors headers at the precision `gezel_video_server.py`
 * actually loads them in.
 *
 * The generic native estimate (weight bytes on disk x 1.5) is built for LLM
 * engines and badly overprices a diffusers tree: LTX-2.x ships its Gemma 3
 * text encoder as 49 GB of float32 that loads as 24 GB of bfloat16, and a
 * diffusion model has no KV cache to reserve for. The generic figure for
 * LTX-2.3 was ~143 GiB, which a 128 GB Mac refused outright, while the
 * pipeline's measured peak (89-91 GiB) fits its 96 GiB GPU budget.
 */

import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { VideoAccelerator } from '@bendyline/gezel';

const GIB = 1024 ** 3;

const DTYPE_BYTES: Record<string, number> = {
  F64: 8,
  F32: 4,
  BF16: 2,
  F16: 2,
  F8_E4M3: 1,
  F8_E5M2: 1,
  I64: 8,
  I32: 4,
  I16: 2,
  I8: 1,
  U8: 1,
  BOOL: 1,
};
const FLOAT_DTYPES = new Set(['F64', 'F32', 'BF16', 'F16', 'F8_E4M3', 'F8_E5M2']);
const OPAQUE_WEIGHT_FILE = /\.(bin|pt|pth|gguf)$/i;
/** A header larger than this is not a safetensors header; price the file by size. */
const MAX_HEADER_BYTES = 100 * 1024 * 1024;

/**
 * Headroom over the resident weights. Measured for LTX-2.3 distilled on an
 * M-series Mac at the catalog default (768x512, 121 frames): 67 GiB of
 * weights settled at a 74 GiB footprint through sampling, then the float32
 * VAE decode of the whole clip peaked at 89 GiB. This covers that peak with a
 * few GiB to spare; a larger frame size decodes proportionally more.
 */
const ACTIVATION_FRACTION = 0.2;
const ACTIVATION_FIXED_BYTES = 12 * GIB;

export interface VideoWorkingSetInput {
  modelDir: string;
  family: string;
  accelerator: VideoAccelerator;
  vaeDtype?: 'float32' | 'bfloat16';
}

export interface VideoWorkingSet {
  /** Resident weight bytes at load precision. */
  weightBytes: number;
  /** Weights plus activation headroom: what the engine asks the ledger for. */
  bytes: number;
}

export async function estimateVideoWorkingSet(
  input: VideoWorkingSetInput,
): Promise<VideoWorkingSet> {
  // Mirrors the server: CPU runs float32 throughout; every accelerator loads
  // bfloat16, except a VAE forced to float32 (WAN always, LTX-2 by catalog).
  const vaeFloat32 = input.family === 'wan' || input.vaeDtype === 'float32';
  const floatBytesFor = (component: string): number => {
    if (input.accelerator === 'cpu') return 4;
    if (component === 'vae' && vaeFloat32) return 4;
    return 2;
  };
  const weightBytes = await weightBytesUnder(input.modelDir, '', floatBytesFor, 0);
  return { weightBytes, bytes: videoWorkingSetBytes(weightBytes) };
}

export function videoWorkingSetBytes(weightBytes: number): number {
  return Math.ceil(weightBytes * (1 + ACTIVATION_FRACTION) + ACTIVATION_FIXED_BYTES);
}

async function weightBytesUnder(
  dir: string,
  component: string,
  floatBytesFor: (component: string) => number,
  depth: number,
): Promise<number> {
  if (depth > 6) return 0;
  const entries = await readdir(dir, { withFileTypes: true });
  // diffusers loads only the shards a directory's index names, so an
  // unsharded duplicate beside them is never resident.
  const indexed = await indexedShards(
    dir,
    entries.map((e) => e.name),
  );
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await weightBytesUnder(path, component || entry.name, floatBytesFor, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.safetensors')) {
      if (indexed && !indexed.has(entry.name)) continue;
      total += await safetensorsLoadedBytes(path, floatBytesFor(component));
    } else if (OPAQUE_WEIGHT_FILE.test(entry.name)) {
      total += (await stat(path)).size;
    }
  }
  return total;
}

async function indexedShards(dir: string, names: string[]): Promise<Set<string> | null> {
  const index = names.find((n) => n.endsWith('.safetensors.index.json'));
  if (!index) return null;
  try {
    const parsed = JSON.parse(await readFile(join(dir, index), 'utf8')) as {
      weight_map?: Record<string, string>;
    };
    const shards = new Set(Object.values(parsed.weight_map ?? {}));
    return shards.size > 0 ? shards : null;
  } catch {
    return null;
  }
}

/** Bytes a safetensors file occupies once loaded; its disk size if the header is unreadable. */
async function safetensorsLoadedBytes(path: string, floatBytes: number): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const lengthBuf = Buffer.alloc(8);
    const { bytesRead } = await handle.read(lengthBuf, 0, 8, 0);
    if (bytesRead < 8) return size;
    const headerLength = Number(lengthBuf.readBigUInt64LE(0));
    if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || headerLength + 8 > size) {
      return size;
    }
    const headerBuf = Buffer.alloc(headerLength);
    await handle.read(headerBuf, 0, headerLength, 8);
    const header = JSON.parse(headerBuf.toString('utf8')) as Record<
      string,
      { dtype?: string; shape?: number[]; data_offsets?: [number, number] }
    >;
    let bytes = 0;
    for (const [name, tensor] of Object.entries(header)) {
      if (name === '__metadata__' || !tensor?.dtype) continue;
      const elements = (tensor.shape ?? []).reduce((acc, dim) => acc * dim, 1);
      if (FLOAT_DTYPES.has(tensor.dtype)) {
        bytes += elements * floatBytes;
      } else {
        const [start, end] = tensor.data_offsets ?? [0, 0];
        bytes += end > start ? end - start : elements * (DTYPE_BYTES[tensor.dtype] ?? 4);
      }
    }
    return bytes;
  } catch {
    return (await stat(path)).size;
  } finally {
    await handle.close();
  }
}
