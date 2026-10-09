import { DEFAULT_MAX_DIGEST_CHARS, toMessageDigest } from '../recognition/digest.js';
import type {
  ImageRecognition,
  ImageStaticMeta,
  MessageImageDigest,
} from '../schemas/recognition.js';

/**
 * What a phone could make of one photo. Every field is optional because each
 * recognizer covers a different part: the OS classifier names what is in the
 * picture, text recognition reads it, and only a describer (ML Kit's Gemini
 * Nano, or a small vision model on llama.cpp) writes a sentence about it.
 */
export interface PortableImageReading {
  description?: string;
  labels?: string[];
  text?: string;
  width?: number;
  height?: number;
  /**
   * Every recognizer that contributed, e.g. `apple-vision`,
   * `mlkit-genai-image-description`, `llama-cpp:smolvlm2-500m`. Empty means
   * nothing could read the image.
   */
  models: string[];
  /**
   * Set when the description tier did not run, so the person can be told
   * why the answer rests on labels alone: no describer on this device, or
   * one that could be installed but is not.
   */
  describer?: 'unavailable' | 'not-installed' | 'failed';
}

export interface PortableVision {
  /** Read one image. Rejects only when no recognizer could run at all. */
  read(input: {
    data: Uint8Array;
    mimeType: string;
    signal: AbortSignal;
  }): Promise<PortableImageReading>;
}

/** Phones run 4K-16K windows; a digest is the user's message, so it must stay small. */
export const PORTABLE_MAX_IMAGES_PER_TURN = 4;
export const PORTABLE_MAX_DIGEST_CHARS = Math.min(DEFAULT_MAX_DIGEST_CHARS, 1200);
const PORTABLE_MAX_LABELS = 8;

export const PORTABLE_IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?)$/i;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export function imageMimeType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** Sniffed from the bytes, not the name: the name is whatever the picker chose. */
export function imageFormat(bytes: Uint8Array): ImageStaticMeta['format'] {
  const at = (index: number) => bytes[index] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'gif';
  if (at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'webp';
  return 'unknown';
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** The image refs a message carries, in order, without repeats. */
export function portableImageRefs(markdown: string): string[] {
  const refs: string[] = [];
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]!.trim().replace(/^<|>$/g, '');
    if (!/^(?:artifacts|workspace)\//.test(target) || !PORTABLE_IMAGE_FILE.test(target)) continue;
    // Kept as written, so the digest's ref matches the text it redacts; a
    // ref that cannot be decoded is left to the attachment scan to refuse.
    try {
      decodeURIComponent(target);
    } catch {
      continue;
    }
    if (!refs.includes(target)) refs.push(target);
  }
  return refs;
}

export function portableImageRecognition(input: {
  bytes: Uint8Array;
  sha256: string;
  reading: PortableImageReading;
  durationMs: number;
  at: string;
}): ImageRecognition {
  const { reading } = input;
  const labels = reading.labels?.filter(Boolean).slice(0, PORTABLE_MAX_LABELS);
  const description = reading.description?.trim();
  const text = reading.text?.trim();
  const read = Boolean(description || labels?.length || text);
  return {
    schemaVersion: 1,
    sha256: input.sha256,
    meta: {
      format: imageFormat(input.bytes),
      ...(reading.width ? { width: reading.width } : {}),
      ...(reading.height ? { height: reading.height } : {}),
      byteLength: input.bytes.byteLength,
      sha256: input.sha256,
    },
    modes: text && !description && !labels?.length ? ['ocr'] : ['describe'],
    ...(description ? { description } : {}),
    ...(labels?.length ? { labels } : {}),
    ...(text ? { ocrText: text } : {}),
    engine: reading.models.some((model) => model.startsWith('llama-cpp:')) ? 'llama-cpp' : 'system',
    modelId: reading.models.join('+') || 'none',
    // Labels without a sentence are a real but partial reading.
    status: description ? 'ok' : read ? 'partial' : 'static-only',
    durationMs: Math.max(0, Math.round(input.durationMs)),
    at: input.at,
  };
}

export function portableImageDigest(
  ref: string,
  recognition: ImageRecognition,
): MessageImageDigest {
  return toMessageDigest(ref, recognition, { maxChars: PORTABLE_MAX_DIGEST_CHARS });
}
