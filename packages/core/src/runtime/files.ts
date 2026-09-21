export interface PortableFileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  /** Unix epoch milliseconds. */
  mtime: number;
}

/** Paths are relative to one app-owned product root; adapters also enforce realpath confinement. */
export interface PortableFileSystem {
  read(path: string): Promise<Uint8Array | null>;
  /** Atomic replacement; does not expose a partially written file. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<PortableFileEntry[]>;
  mkdir(path: string): Promise<void>;
  /** Remove a file or directory tree. Missing paths are harmless. */
  remove(path: string): Promise<void>;
  /** Rename without replacing an existing destination. */
  rename(from: string, to: string): Promise<void>;
}

const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function validatePortablePath(path: string, allowRoot = false): string {
  if (typeof path !== 'string' || path.length > 1024 || (!path && !allowRoot))
    throw new Error('A bounded relative file path is required');
  if (!path) return path;
  const segments = path.split('/');
  if (
    segments.length > 128 ||
    segments.some((segment) => new TextEncoder().encode(segment).byteLength > 255)
  )
    throw new Error('File path exceeds its supported segment or nesting limit');
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    path.includes(':') ||
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('File path must stay inside its workspace');
  if (
    path
      .split('/')
      .some(
        (part) =>
          !part || part === '.' || part === '..' || /[ .]$/.test(part) || RESERVED.test(part),
      )
  )
    throw new Error('File path contains an unsafe segment');
  if (/\{\{.*?\}\}/.test(path)) throw new Error('File path contains an unresolved template');
  return path;
}

export const PORTABLE_MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const PORTABLE_MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const encodeText = (value: string): Uint8Array => new TextEncoder().encode(value);
export function decodeText(value: Uint8Array, maximum = PORTABLE_MAX_TEXT_BYTES): string {
  if (value.byteLength > maximum) throw new Error('File exceeds the supported text size');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
  if (text.includes('\0')) throw new Error('This file is not supported as text');
  return text;
}
export function boundedText(value: string): Uint8Array {
  const bytes = encodeText(value);
  decodeText(bytes);
  return bytes;
}
export function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

export async function readText(
  files: PortableFileSystem,
  path: string,
  maximum = PORTABLE_MAX_TEXT_BYTES,
): Promise<string | null> {
  const bytes = await files.read(validatePortablePath(path));
  return bytes === null ? null : decodeText(bytes, maximum);
}
