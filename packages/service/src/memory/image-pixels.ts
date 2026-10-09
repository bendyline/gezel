/**
 * Pure-JS image decode + preprocessing for the on-device image embedders.
 *
 * gezel deliberately ships a throwing `sharp` stub (packages/sharp-compat) and
 * a packaging guard that fails any build containing real sharp/libvips, which
 * makes transformers.js's whole Node image path (RawImage.read, AutoProcessor
 * resize/crop) unusable here. This module is the reviewed replacement: small
 * pure-JS decoders (@pdf-lib/upng for PNG, jpeg-js for JPEG — no native code,
 * no wasm, no postinstall) plus hand-rolled geometry/normalization that feeds
 * pixel tensors directly to the vision model, so the stub and its guard stand.
 *
 * Geometry follows the Gemma vision processor: an aspect-preserving resize to
 * whole pooling blocks within the token budget, with PIL's antialiased
 * bicubic kernel (≥ 0.99 cosine against the sharp-based reference). The face
 * lane keeps a plain bilinear resize. Every function is pure and
 * typed-array-in/typed-array-out, so the whole path unit-tests with tiny
 * fixtures and exact expected values.
 */

import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { readImageMeta, readImageStaticMeta } from '../index-store/image-meta.js';

// Both decoders are CJS (upng via a babel `exports.default` build), so Node's
// ESM named-import interop can't reach their functions — createRequire is the
// deterministic path and keeps the d.ts shapes for typing.
const cjsRequire = createRequire(import.meta.url);
type UpngModule = typeof import('@pdf-lib/upng');
type JpegModule = typeof import('jpeg-js');
const UPNG = (() => {
  const mod = cjsRequire('@pdf-lib/upng') as { default?: UpngModule } & UpngModule;
  return mod.default ?? mod;
})();
const jpeg = cjsRequire('jpeg-js') as JpegModule;

/** Formats the pure-JS decoders cover. webp/gif/bmp are v1-unsupported. */
export const IMAGE_EMBED_EXTS = new Set(['.png', '.jpg', '.jpeg']);

/**
 * Pixel-count ceiling enforced from header dims BEFORE any decoder allocates:
 * 40 MP × 4 B = 160 MB RGBA, the bound for one transient allocation in the
 * worker. A 20k×20k decode bomb is rejected from 33 header bytes.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** File-size ceiling — larger than any sane photo, cheap first gate. */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export interface RgbaImage {
  /** Interleaved RGBA, 4 bytes per pixel. */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RgbImage {
  /** Interleaved RGB, 3 bytes per pixel. */
  data: Uint8Array;
  width: number;
  height: number;
}

export class ImageDecodeError extends Error {
  constructor(
    message: string,
    readonly reason: 'unsupported' | 'too-large' | 'decode-failed',
  ) {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

/**
 * Read at most MAX_IMAGE_BYTES from one already-open file descriptor. The
 * fstat gate avoids allocating for an obviously oversized file, while the
 * one-byte probe catches growth between fstat and read without ever allowing
 * an unbounded readFile allocation.
 */
export async function readBoundedImageFile(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new ImageDecodeError('image path is not a regular file', 'decode-failed');
    }
    if (info.size > MAX_IMAGE_BYTES) {
      throw new ImageDecodeError(
        `image is ${info.size} bytes (cap ${MAX_IMAGE_BYTES})`,
        'too-large',
      );
    }

    const capacity = Math.min(MAX_IMAGE_BYTES + 1, Math.max(1, info.size + 1));
    const bytes = Buffer.allocUnsafe(capacity);
    let offset = 0;
    while (offset < capacity) {
      const read = await handle.read(bytes, offset, capacity - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_IMAGE_BYTES) {
      throw new ImageDecodeError(
        `image grew past the ${MAX_IMAGE_BYTES} byte cap while being read`,
        'too-large',
      );
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/**
 * Decode a PNG or JPEG buffer to RGBA8, with EXIF orientation applied for
 * JPEG. Throws {@link ImageDecodeError} with a terminal-skip reason for
 * anything the tier should never retry.
 */
export function decodeImage(buf: Buffer): RgbaImage {
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new ImageDecodeError(
      `image is ${buf.length} bytes (cap ${MAX_IMAGE_BYTES})`,
      'too-large',
    );
  }
  const meta = readImageMeta(buf);
  if (!meta || (meta.format !== 'png' && meta.format !== 'jpeg')) {
    throw new ImageDecodeError(
      `no pure-JS decoder for ${meta?.format ?? 'unknown'}`,
      'unsupported',
    );
  }
  if (meta.width * meta.height > MAX_IMAGE_PIXELS) {
    throw new ImageDecodeError(
      `${meta.width}x${meta.height} exceeds the ${MAX_IMAGE_PIXELS}-pixel cap`,
      'too-large',
    );
  }
  try {
    if (meta.format === 'png') {
      // Copy into a plain ArrayBuffer — Buffer views can sit on a pooled (or
      // Shared) backing store UPNG's typings reject.
      const bytes = new ArrayBuffer(buf.byteLength);
      new Uint8Array(bytes).set(buf);
      const img = UPNG.decode(bytes);
      // toRGBA8 normalizes palette/16-bit/interlace; frame 0 for APNG.
      const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]!);
      return { data: rgba, width: img.width, height: img.height };
    }
    const decoded = jpeg.decode(buf, {
      useTArray: true,
      formatAsRGBA: true,
      // Belt-and-braces under the header-dims cap above.
      maxResolutionInMP: Math.ceil(MAX_IMAGE_PIXELS / 1_000_000),
      maxMemoryUsageInMB: 512,
    });
    const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
    const orientation = readImageStaticMeta(buf).exif?.orientation;
    return orientation && orientation !== 1 ? applyOrientation(image, orientation) : image;
  } catch (err) {
    if (err instanceof ImageDecodeError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ImageDecodeError(`decode failed: ${msg}`, 'decode-failed');
  }
}

/**
 * Apply an EXIF orientation (2–8) to an RGBA image. Orientations 5–8 swap
 * width/height. Mapping is dest→source so each output pixel is written once.
 */
export function applyOrientation(image: RgbaImage, orientation: number): RgbaImage {
  if (orientation <= 1 || orientation > 8) return image;
  const { data, width: w, height: h } = image;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8Array(ow * oh * 4);
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2: // mirror horizontal
          sx = w - 1 - ox;
          sy = oy;
          break;
        case 3: // rotate 180
          sx = w - 1 - ox;
          sy = h - 1 - oy;
          break;
        case 4: // mirror vertical
          sx = ox;
          sy = h - 1 - oy;
          break;
        case 5: // transpose (mirror + rotate 270 CW)
          sx = oy;
          sy = ox;
          break;
        case 6: // rotate 90 CW
          sx = oy;
          sy = h - 1 - ox;
          break;
        case 7: // transverse (mirror + rotate 90 CW)
          sx = w - 1 - oy;
          sy = h - 1 - ox;
          break;
        default: // 8: rotate 270 CW
          sx = w - 1 - oy;
          sy = ox;
          break;
      }
      const si = (sy * w + sx) * 4;
      const oi = (oy * ow + ox) * 4;
      out[oi] = data[si]!;
      out[oi + 1] = data[si + 1]!;
      out[oi + 2] = data[si + 2]!;
      out[oi + 3] = data[si + 3]!;
    }
  }
  return { data: out, width: ow, height: oh };
}

/** Drop alpha, compositing translucent pixels over white (scan/diagram bias). */
export function rgbaToRgb(image: RgbaImage): RgbImage {
  const { data, width, height } = image;
  const out = new Uint8Array(width * height * 3);
  for (let p = 0, o = 0; p < data.length; p += 4, o += 3) {
    const a = data[p + 3]!;
    if (a === 255) {
      out[o] = data[p]!;
      out[o + 1] = data[p + 1]!;
      out[o + 2] = data[p + 2]!;
    } else {
      const inv = 255 - a;
      out[o] = Math.round((data[p]! * a + 255 * inv) / 255);
      out[o + 1] = Math.round((data[p + 1]! * a + 255 * inv) / 255);
      out[o + 2] = Math.round((data[p + 2]! * a + 255 * inv) / 255);
    }
  }
  return { data: out, width, height };
}

/** Bilinear resample an RGB image to exactly targetW×targetH. */
export function resizeBilinear(image: RgbImage, targetW: number, targetH: number): RgbImage {
  const { data, width: w, height: h } = image;
  if (w === targetW && h === targetH) return image;
  const out = new Uint8Array(targetW * targetH * 3);
  for (let y = 0; y < targetH; y++) {
    // Pixel-center alignment: dest center maps into source coordinates.
    const syf = Math.min(Math.max(((y + 0.5) * h) / targetH - 0.5, 0), h - 1);
    const y0 = Math.floor(syf);
    const y1 = Math.min(y0 + 1, h - 1);
    const fy = syf - y0;
    for (let x = 0; x < targetW; x++) {
      const sxf = Math.min(Math.max(((x + 0.5) * w) / targetW - 0.5, 0), w - 1);
      const x0 = Math.floor(sxf);
      const x1 = Math.min(x0 + 1, w - 1);
      const fx = sxf - x0;
      const i00 = (y0 * w + x0) * 3;
      const i01 = (y0 * w + x1) * 3;
      const i10 = (y1 * w + x0) * 3;
      const i11 = (y1 * w + x1) * 3;
      const oi = (y * targetW + x) * 3;
      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c]! * (1 - fx) + data[i01 + c]! * fx;
        const bottom = data[i10 + c]! * (1 - fx) + data[i11 + c]! * fx;
        out[oi + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { data: out, width: targetW, height: targetH };
}

/** Cubic convolution kernel with a = −0.5 (PIL's BICUBIC). */
function cubicWeight(x: number): number {
  const a = -0.5;
  const t = Math.abs(x);
  if (t < 1) return ((a + 2) * t - (a + 3)) * t * t + 1;
  if (t < 2) return (((t - 5) * t + 8) * t - 4) * a;
  return 0;
}

/**
 * Per-output-index source windows and normalized weights for one axis,
 * antialiased like PIL: when shrinking, the kernel widens by the scale so
 * every source pixel contributes.
 */
function cubicTaps(inSize: number, outSize: number): Array<{ start: number; weights: number[] }> {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = 2 * filterScale;
  const taps: Array<{ start: number; weights: number[] }> = [];
  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * scale;
    const start = Math.max(Math.floor(center - support + 0.5), 0);
    const end = Math.min(Math.floor(center + support + 0.5), inSize);
    const weights: number[] = [];
    let sum = 0;
    for (let i = start; i < end; i++) {
      const w = cubicWeight((i - center + 0.5) / filterScale);
      weights.push(w);
      sum += w;
    }
    taps.push({ start, weights: sum === 0 ? weights : weights.map((w) => w / sum) });
  }
  return taps;
}

/**
 * Bicubic resample an RGB image to exactly targetW×targetH: separable,
 * antialiased cubic convolution (a = −0.5), the BICUBIC filter the Gemma 4
 * image processor names. The intermediate pass stays in floating point; the
 * result rounds and clamps once.
 */
export function resizeBicubic(image: RgbImage, targetW: number, targetH: number): RgbImage {
  const { data, width: w, height: h } = image;
  if (w === targetW && h === targetH) return image;
  const xTaps = cubicTaps(w, targetW);
  const yTaps = cubicTaps(h, targetH);
  const mid = new Float32Array(targetW * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < targetW; x++) {
      const { start, weights } = xTaps[x]!;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < weights.length; k++) {
        const si = (y * w + start + k) * 3;
        const wt = weights[k]!;
        r += data[si]! * wt;
        g += data[si + 1]! * wt;
        b += data[si + 2]! * wt;
      }
      const mi = (y * targetW + x) * 3;
      mid[mi] = r;
      mid[mi + 1] = g;
      mid[mi + 2] = b;
    }
  }
  const out = new Uint8Array(targetW * targetH * 3);
  for (let y = 0; y < targetH; y++) {
    const { start, weights } = yTaps[y]!;
    for (let x = 0; x < targetW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < weights.length; k++) {
        const mi = ((start + k) * targetW + x) * 3;
        const wt = weights[k]!;
        r += mid[mi]! * wt;
        g += mid[mi + 1]! * wt;
        b += mid[mi + 2]! * wt;
      }
      const oi = (y * targetW + x) * 3;
      out[oi] = Math.min(255, Math.max(0, Math.round(r)));
      out[oi + 1] = Math.min(255, Math.max(0, Math.round(g)));
      out[oi + 2] = Math.min(255, Math.max(0, Math.round(b)));
    }
  }
  return { data: out, width: targetW, height: targetH };
}

/**
 * The size the Gemma 4 image processor resizes to for a vision token budget:
 * aspect preserved, the pixel area fitted to `tokenBudget · kernel² ·
 * patch²`, each side floored to a multiple of `kernel · patch` (one pooled
 * soft token). Pre-resizing to exactly this size is what keeps the processor
 * from calling its own (sharp-backed) resize. Mirrors
 * `get_aspect_ratio_preserving_size` in transformers.js.
 */
export function gemmaVisionTargetSize(
  width: number,
  height: number,
  tokenBudget: number,
  patchSize = 16,
  poolingKernel = 3,
): { width: number; height: number } {
  const maxPatches = tokenBudget * poolingKernel ** 2;
  const factor = Math.sqrt((maxPatches * patchSize ** 2) / (height * width));
  const sideMult = poolingKernel * patchSize;
  let targetH = Math.floor((factor * height) / sideMult) * sideMult;
  let targetW = Math.floor((factor * width) / sideMult) * sideMult;
  if (targetH === 0 && targetW === 0) {
    throw new ImageDecodeError(`image ${width}x${height} is too small to encode`, 'unsupported');
  }
  const maxSide = Math.floor(maxPatches / poolingKernel ** 2) * sideMult;
  if (targetH === 0) {
    targetH = sideMult;
    targetW = Math.min(Math.floor(width / height) * sideMult, maxSide);
  } else if (targetW === 0) {
    targetW = sideMult;
    targetH = Math.min(Math.floor(height / width) * sideMult, maxSide);
  }
  return { width: targetW, height: targetH };
}

/**
 * Whether a size is already a valid vision-encoder input for `tokenBudget`:
 * both sides whole pooling blocks and the patch count within the budget.
 * The processor's own sizing rule is not idempotent — applied to its own
 * output it can add a block to one side — so frames that were sized once
 * (ffmpeg scales video frames from the source dimensions) must be recognised
 * rather than sized again.
 */
export function isGemmaVisionSize(
  width: number,
  height: number,
  tokenBudget: number,
  patchSize = 16,
  poolingKernel = 3,
): boolean {
  const sideMult = poolingKernel * patchSize;
  if (width <= 0 || height <= 0 || width % sideMult !== 0 || height % sideMult !== 0) return false;
  return (width / patchSize) * (height / patchSize) <= tokenBudget * poolingKernel ** 2;
}
