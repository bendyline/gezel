/**
 * MockImageProvider — deterministic image generation for tests and for the
 * `GEZEL_MOCK_PROVIDER=1` flow. Produces a tiny, valid PNG whose pixel
 * colour is derived from a hash of the prompt so different prompts yield
 * visually different (but still trivially small) outputs.
 */

import { deflateSync } from 'node:zlib';
import type {
  ImageEngineHealth,
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageModelPullEvent,
  ImageModelPullSpec,
  ImageProvider,
  InstalledImageModelInfo,
} from './types.js';

export class MockImageProvider implements ImageProvider {
  readonly name = 'mock';

  private readonly installed = new Map<string, InstalledImageModelInfo>();
  /** Internal counter driving deterministic seed generation on "random" seeds. */
  private nextSeed = 1;

  constructor(opts: { preinstalled?: InstalledImageModelInfo[] } = {}) {
    for (const m of opts.preinstalled ?? []) {
      this.installed.set(m.id, m);
    }
  }

  /** Number of input images received on the most recent generate(). Tests use this. */
  lastInputImageCount = 0;

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    this.lastInputImageCount = input.inputImages?.length ?? 0;
    const width = clamp(input.width ?? 16, 1, 512);
    const height = clamp(input.height ?? 16, 1, 512);
    const steps = clamp(input.steps ?? 1, 1, 100);
    const seed = input.seed ?? this.nextSeed++;
    const model = input.model ?? [...this.installed.keys()][0] ?? 'mock-model';
    const rgba = solidFill(width, height, colourForPrompt(input.prompt));
    const png = encodePng(rgba, width, height);
    return {
      png,
      meta: {
        model,
        seed,
        steps,
        widthPx: width,
        heightPx: height,
        durationMs: 1,
      },
    };
  }

  async listInstalledModels(): Promise<InstalledImageModelInfo[]> {
    return [...this.installed.values()];
  }

  async *pullModel(
    id: string,
    spec: ImageModelPullSpec,
    signal?: AbortSignal,
  ): AsyncIterable<ImageModelPullEvent> {
    const total = spec.approxSizeBytes;
    for (const step of [0.25, 0.5, 0.75, 1]) {
      if (signal?.aborted) {
        yield { type: 'error', error: 'download aborted' };
        yield { type: 'done', id };
        return;
      }
      // Tiny tick so tests can observe a mid-pull state between steps.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5);
        t.unref?.();
      });
      yield { type: 'progress', bytesWritten: Math.round(total * step), totalBytes: total };
    }
    this.installed.set(id, {
      id,
      name: spec.name,
      approxSizeBytes: total,
      installedAt: new Date().toISOString(),
    });
    yield { type: 'done', id };
  }

  async deleteModel(id: string): Promise<void> {
    this.installed.delete(id);
  }

  async health(): Promise<ImageEngineHealth> {
    return { status: 'ok', baseUrl: 'mock://image' };
  }
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Hash the prompt to an `[r, g, b]` tuple so different prompts paint different pixels. */
function colourForPrompt(prompt: string): [number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < prompt.length; i++) {
    h ^= prompt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff];
}

function solidFill(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 0xff;
  }
  return rgba;
}

// ── Minimal PNG encoder (RGBA, no filter) ──────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!)! & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const buf = Buffer.alloc(8 + data.length + 4);
  buf.writeUInt32BE(data.length, 0);
  typeBytes.copy(buf, 4);
  Buffer.from(data).copy(buf, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  buf.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return buf;
}

function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
