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
 * Geometry follows the CLIP reference preprocessing: resize shortest side to
 * the target, then center-crop a square. Bilinear rather than the reference
 * bicubic — the embedding delta is irrelevant for nearest-neighbor retrieval
 * and the kernel is a quarter of the code. Every function is pure and
 *typed-array-in/typed-array-out, so the whole path unit-tests with tiny
 * fixtures and exact expected floats.
 */

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

/** Scale so the SHORTEST side equals `target` (aspect preserved, round up). */
export function resizeShortestSide(image: RgbImage, target: number): RgbImage {
  const { width, height } = image;
  if (Math.min(width, height) === target) return image;
  const scale = target / Math.min(width, height);
  return resizeBilinear(
    image,
    Math.max(target, Math.round(width * scale)),
    Math.max(target, Math.round(height * scale)),
  );
}

/** Center-crop to cw×ch (inputs must be at least that large). */
export function centerCrop(image: RgbImage, cw: number, ch: number): RgbImage {
  const { data, width, height } = image;
  if (width === cw && height === ch) return image;
  const left = Math.floor((width - cw) / 2);
  const top = Math.floor((height - ch) / 2);
  const out = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    const srcStart = ((top + y) * width + left) * 3;
    out.set(data.subarray(srcStart, srcStart + cw * 3), y * cw * 3);
  }
  return { data: out, width: cw, height: ch };
}

/** OpenAI CLIP normalization constants (all ViT CLIP checkpoints). */
export const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
export const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const;

/**
 * Interleaved RGB8 → planar CHW Float32, `(px/255 - mean[c]) / std[c]` per
 * channel — the tensor layout every torchvision-lineage vision model expects.
 */
export function normalizeToCHW(
  image: RgbImage,
  mean: readonly number[] = CLIP_MEAN,
  std: readonly number[] = CLIP_STD,
): Float32Array {
  const { data, width, height } = image;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * plane + i] = (data[i * 3 + c]! / 255 - mean[c]!) / std[c]!;
    }
  }
  return out;
}

/**
 * The full CLIP preprocessing chain: decode → RGB → shortest-side resize →
 * center-crop → normalized CHW tensor data for a [1, 3, size, size] input.
 */
export function preprocessForClip(buf: Buffer, size = 224): Float32Array {
  const rgb = rgbaToRgb(decodeImage(buf));
  return normalizeToCHW(centerCrop(resizeShortestSide(rgb, size), size, size));
}
