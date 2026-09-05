/**
 * Assets: images a catalog ships under `assets/` for its document bodies.
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
export type KnowledgeAssetExtension = keyof typeof KNOWLEDGE_ASSET_TYPES;
export type KnowledgeAssetKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'svg';

export const MAX_KNOWLEDGE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_KNOWLEDGE_ASSETS_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_KNOWLEDGE_ASSET_COUNT = 8_192;
export const MAX_KNOWLEDGE_ASSET_PATH_LENGTH = 512;

/**
 * `assets/(<dir>/)*<name>.<ext>` — up to 15 directory segments, each
 * segment `[A-Za-z0-9._-]` and never starting with a dot (so `.`, `..` and
 * hidden files are impossible by construction), extension from the table.
 */
export const KNOWLEDGE_ASSET_PATH_PATTERN =
  /^assets\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/){0,15}[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|gif|webp|svg)$/i;

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
  return Object.hasOwn(KNOWLEDGE_ASSET_TYPES, ext) ? (ext as KnowledgeAssetExtension) : null;
}

/** The media type an asset path implies, from its extension. */
export function assetContentType(path: string): string | null {
  const ext = assetExtension(path);
  return ext ? KNOWLEDGE_ASSET_TYPES[ext] : null;
}

/** The kind an extension declares, normalized (`jpg` and `jpeg` are one kind). */
export function assetKindForExtension(ext: KnowledgeAssetExtension): KnowledgeAssetKind {
  return ext === 'jpg' ? 'jpeg' : ext;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/**
 * What the leading bytes say the file is. Rasters are recognized by their
 * magic numbers; an SVG is UTF-8 text whose first element, after any BOM,
 * whitespace, XML declaration, comments and DOCTYPE, is `<svg`.
 */
export function sniffAssetType(bytes: Uint8Array): KnowledgeAssetKind | null {
  if (startsWith(bytes, PNG_MAGIC)) return 'png';
  if (startsWith(bytes, JPEG_MAGIC)) return 'jpeg';
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'gif';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'webp';
  return looksLikeSvg(decodeText(bytes)) ? 'svg' : null;
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
