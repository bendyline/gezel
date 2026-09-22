import { PORTABLE_PATH_RULES, type PathRuleCode, findPathRuleViolation } from '../path-rules.js';
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

const PATH_RULE_MESSAGES: Record<PathRuleCode, string> = {
  empty: 'A bounded relative file path is required',
  'too-long': 'A bounded relative file path is required',
  'too-deep': 'File path exceeds its supported segment or nesting limit',
  'segment-too-long': 'File path exceeds its supported segment or nesting limit',
  nul: 'File path must stay inside its workspace',
  'control-char': 'File path must stay inside its workspace',
  backslash: 'File path must stay inside its workspace',
  unc: 'File path must stay inside its workspace',
  absolute: 'File path must stay inside its workspace',
  colon: 'File path must stay inside its workspace',
  'empty-segment': 'File path contains an unsafe segment',
  'dot-segment': 'File path contains an unsafe segment',
  'trailing-space-or-dot': 'File path contains an unsafe segment',
  'reserved-name': 'File path contains an unsafe segment',
  'template-placeholder': 'File path contains an unresolved template',
};

/** The shared rule table, with this host's messages. */
export function validatePortablePath(path: string, allowRoot = false): string {
  const violation = findPathRuleViolation(path, { ...PORTABLE_PATH_RULES, allowRoot });
  if (violation) throw new Error(PATH_RULE_MESSAGES[violation.code]);
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
