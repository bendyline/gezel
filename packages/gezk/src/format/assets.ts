/**
 * Assets: files a catalog ships under `assets/` for its document bodies —
 * images since 0.6, and since 0.8 the audio and video its media rows embed.
 * A document references one by its archive path (`![alt](assets/x.png)`),
 * and a reader resolves that against the catalog, never the network. The
 * rules here are the format's: which files may be assets, how large, and
 * the inertness an SVG must prove before a reader serves it — an SVG is a
 * document, not a bitmap, so the format refuses anything that could run.
 */

import { z } from 'zod';

export const ASSETS_PREFIX = 'assets/';

export const KNOWLEDGE_ASSET_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
} as const;

/**
 * Audio and video assets (0.8). A reader hands these bytes to the platform's
 * own media element and never parses them itself; only a catalog builder
 * decodes them, to embed their windows.
 */
export const KNOWLEDGE_MEDIA_ASSET_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
} as const;

export type KnowledgeImageAssetExtension = keyof typeof KNOWLEDGE_ASSET_TYPES;
export type KnowledgeMediaAssetExtension = keyof typeof KNOWLEDGE_MEDIA_ASSET_TYPES;
export type KnowledgeAssetExtension = KnowledgeImageAssetExtension | KnowledgeMediaAssetExtension;
/** What the leading bytes can prove; ISO BMFF covers both mp4 and m4a. */
export type KnowledgeAssetKind =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'svg'
  | 'isobmff'
  | 'webm'
  | 'mp3'
  | 'ogg'
  | 'wav'
  | 'flac';
export type KnowledgeAssetModality = 'image' | 'video' | 'audio';

export const MAX_KNOWLEDGE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_KNOWLEDGE_ASSETS_TOTAL_BYTES = 256 * 1024 * 1024;
/** Per-file limit for an audio or video asset (0.8). */
export const MAX_KNOWLEDGE_MEDIA_ASSET_BYTES = 512 * 1024 * 1024;
/** Combined limit for every audio and video asset in one catalog (0.8). */
export const MAX_KNOWLEDGE_MEDIA_ASSETS_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_KNOWLEDGE_ASSET_COUNT = 8_192;
export const MAX_KNOWLEDGE_ASSET_PATH_LENGTH = 512;

/**
 * `assets/(<dir>/)*<name>.<ext>` — up to 15 directory segments, each
 * segment `[A-Za-z0-9._-]` and never starting with a dot (so `.`, `..` and
 * hidden files are impossible by construction), extension from the image
 * table (every generation since 0.6) or the media table (0.8).
 */
export const KNOWLEDGE_ASSET_PATH_PATTERN =
  /^assets\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/){0,15}[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|gif|webp|svg|mp4|webm|mp3|m4a|ogg|opus|wav|flac)$/i;

export const KnowledgeAssetPathSchema = z
  .string()
  .max(MAX_KNOWLEDGE_ASSET_PATH_LENGTH)
  .regex(KNOWLEDGE_ASSET_PATH_PATTERN, 'not a valid asset path');

export function isKnowledgeAssetPath(path: string): boolean {
  return path.length <= MAX_KNOWLEDGE_ASSET_PATH_LENGTH && KNOWLEDGE_ASSET_PATH_PATTERN.test(path);
}

export function assetExtension(path: string): KnowledgeAssetExtension | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  if (Object.hasOwn(KNOWLEDGE_ASSET_TYPES, ext)) return ext as KnowledgeImageAssetExtension;
  if (Object.hasOwn(KNOWLEDGE_MEDIA_ASSET_TYPES, ext)) return ext as KnowledgeMediaAssetExtension;
  return null;
}

/** The media type an asset path implies, from its extension. */
export function assetContentType(path: string): string | null {
  const ext = assetExtension(path);
  if (!ext) return null;
  return ext in KNOWLEDGE_ASSET_TYPES
    ? KNOWLEDGE_ASSET_TYPES[ext as KnowledgeImageAssetExtension]
    : KNOWLEDGE_MEDIA_ASSET_TYPES[ext as KnowledgeMediaAssetExtension];
}

/** Whether an asset path is audio or video, which only 0.8 catalogs may ship. */
export function isKnowledgeMediaAssetPath(path: string): boolean {
  const ext = assetExtension(path);
  return ext !== null && Object.hasOwn(KNOWLEDGE_MEDIA_ASSET_TYPES, ext);
}

/** What kind of media row an asset can back, from its extension. */
export function assetModality(path: string): KnowledgeAssetModality | null {
  const ext = assetExtension(path);
  if (!ext) return null;
  if (ext === 'mp4' || ext === 'webm') return 'video';
  return Object.hasOwn(KNOWLEDGE_MEDIA_ASSET_TYPES, ext) ? 'audio' : 'image';
}

/** The per-file size limit for an asset path. */
export function maxKnowledgeAssetBytes(path: string): number {
  return isKnowledgeMediaAssetPath(path)
    ? MAX_KNOWLEDGE_MEDIA_ASSET_BYTES
    : MAX_KNOWLEDGE_ASSET_BYTES;
}

/**
 * Why a set of asset files breaks the format's size and count limits, or
 * null. Images and media have separate per-file and total budgets; the
 * count limit covers both.
 */
export function knowledgeAssetLimitsProblem(
  files: ReadonlyArray<{ path: string; sizeBytes: number }>,
): string | null {
  if (files.length > MAX_KNOWLEDGE_ASSET_COUNT) {
    return `${files.length} assets exceed the ${MAX_KNOWLEDGE_ASSET_COUNT}-file limit`;
  }
  let imageBytes = 0;
  let mediaBytes = 0;
  for (const file of files) {
    if (file.sizeBytes > maxKnowledgeAssetBytes(file.path)) {
      return `${file.path} is ${file.sizeBytes} bytes, over its ${maxKnowledgeAssetBytes(file.path)}-byte limit`;
    }
    if (isKnowledgeMediaAssetPath(file.path)) mediaBytes += file.sizeBytes;
    else imageBytes += file.sizeBytes;
  }
  if (imageBytes > MAX_KNOWLEDGE_ASSETS_TOTAL_BYTES) {
    return `image assets total ${imageBytes} bytes, over the ${MAX_KNOWLEDGE_ASSETS_TOTAL_BYTES}-byte limit`;
  }
  if (mediaBytes > MAX_KNOWLEDGE_MEDIA_ASSETS_TOTAL_BYTES) {
    return `audio and video assets total ${mediaBytes} bytes, over the ${MAX_KNOWLEDGE_MEDIA_ASSETS_TOTAL_BYTES}-byte limit`;
  }
  return null;
}

/** The kind an extension declares, normalized (`jpg`/`jpeg`, `mp4`/`m4a`, `ogg`/`opus`). */
export function assetKindForExtension(ext: KnowledgeAssetExtension): KnowledgeAssetKind {
  switch (ext) {
    case 'jpg':
      return 'jpeg';
    case 'mp4':
    case 'm4a':
      return 'isobmff';
    case 'opus':
      return 'ogg';
    default:
      return ext;
  }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const WAVE = [0x57, 0x41, 0x56, 0x45];
const FTYP = [0x66, 0x74, 0x79, 0x70];
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const OGGS = [0x4f, 0x67, 0x67, 0x53];
const FLAC = [0x66, 0x4c, 0x61, 0x43];
const ID3 = [0x49, 0x44, 0x33];

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/**
 * What the leading bytes say the file is. Rasters and audio/video containers
 * are recognized by their magic numbers; an SVG is UTF-8 text whose first
 * element, after any BOM, whitespace, XML declaration, comments and DOCTYPE,
 * is `<svg`.
 */
export function sniffAssetType(bytes: Uint8Array): KnowledgeAssetKind | null {
  if (startsWith(bytes, PNG_MAGIC)) return 'png';
  if (startsWith(bytes, JPEG_MAGIC)) return 'jpeg';
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'gif';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'webp';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WAVE, 8)) return 'wav';
  if (startsWith(bytes, FTYP, 4)) return 'isobmff';
  if (startsWith(bytes, EBML)) return 'webm';
  if (startsWith(bytes, OGGS)) return 'ogg';
  if (startsWith(bytes, FLAC)) return 'flac';
  if (startsWith(bytes, ID3) || isMpegAudioFrame(bytes)) return 'mp3';
  return looksLikeSvg(decodeText(bytes)) ? 'svg' : null;
}

/** An MPEG audio frame header: 11 sync bits, then a layer that is not "reserved". */
function isMpegAudioFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const b0 = bytes[0] as number;
  const b1 = bytes[1] as number;
  return b0 === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return '';
  }
}

function looksLikeSvg(text: string): boolean {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0xfeff) {
      i++;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    if (/^<!doctype/i.test(text.slice(i, i + 9))) {
      const bracket = text.indexOf('[', i);
      const close = text.indexOf('>', i);
      if (close < 0) return false;
      if (bracket >= 0 && bracket < close) {
        const end = text.indexOf(']>', bracket);
        if (end < 0) return false;
        i = end + 2;
      } else {
        i = close + 1;
      }
      continue;
    }
    return /^<svg[\s>/]/i.test(text.slice(i, i + 5));
  }
  return false;
}

const SVG_ACTIVE_PATTERNS: Array<[RegExp, string]> = [
  [/<script[\s>/]/i, 'a <script> element'],
  [/<foreignobject[\s>/]/i, 'a <foreignObject> element'],
  [/<!entity/i, 'an entity declaration'],
  [/\son[a-z]+\s*=/i, 'an event-handler attribute'],
  [/javascript\s*:/i, 'a javascript: reference'],
  [/data\s*:\s*text\/html/i, 'a data:text/html reference'],
  [/@import/i, 'a CSS @import'],
];

const HREF_ATTRIBUTE = /(?:xlink:)?href\s*=\s*["']\s*([^"']*)["']/gi;
const CSS_URL = /url\(\s*["']?\s*([^"')]*)/gi;

function externalReferenceProblem(target: string): string | null {
  const value = target.trim();
  if (value === '' || value.startsWith('#')) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (!scheme) return null;
  if (/^data:image\/(?:png|jpeg|gif|webp)[;,]/i.test(value)) return null;
  return `a ${scheme[1]}: reference`;
}

/**
 * Why an SVG is not inert, or `null` when it is. Scripts, event handlers,
 * foreign content, entity declarations and any reference that leaves the
 * file (other than embedded raster data) all disqualify it: a reader may
 * hand the bytes to an image element, but it may also let a person open
 * them directly, and an SVG that can run is a page, not a picture.
 */
export function svgInertnessProblem(bytes: Uint8Array): string | null {
  const text = decodeText(bytes);
  if (text === '') return 'not valid UTF-8';
  if (!looksLikeSvg(text)) return 'does not start with an <svg> element';
  for (const [pattern, why] of SVG_ACTIVE_PATTERNS) {
    if (pattern.test(text)) return `contains ${why}`;
  }
  for (const match of text.matchAll(HREF_ATTRIBUTE)) {
    const problem = externalReferenceProblem(match[1] ?? '');
    if (problem) return `contains ${problem} in an href`;
  }
  for (const match of text.matchAll(CSS_URL)) {
    const problem = externalReferenceProblem(match[1] ?? '');
    if (problem) return `contains ${problem} in a CSS url()`;
  }
  return null;
}
