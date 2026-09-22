/**
 * The string-level rules a relative file path must satisfy on every host.
 *
 * The portable runtime and the desktop store each encoded these once, and the
 * two tables had drifted (one recognised `CON .txt` as reserved, the other did
 * not). Here they are once, as pure string checks with no filesystem access.
 * What differs by host is expressed as options: the desktop treats a
 * backslash as a separator and lets `safeJoin` resolve dot segments, while a
 * browser host forbids both outright. Symlink containment stays with the
 * desktop, which is the only host that can call `realpath`.
 *
 * Dependency-free on purpose: `entity-id.ts` and the `paths` entry import it.
 */

export const RESERVED_WINDOWS_BASENAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * Whether a single path segment is a name Windows reserves for a device.
 * The extension is ignored (`CON.txt` is reserved) and so is trailing
 * whitespace, which Windows strips before it looks.
 */
export function isReservedWindowsName(name: string): boolean {
  if (!name) return false;
  const normalized = name.replace(/[ .]+$/g, '');
  const base = (normalized.split('.')[0] ?? '').replace(/[ ]+$/g, '');
  return RESERVED_WINDOWS_BASENAMES.has(base.toUpperCase());
}

/**
 * The token shape `interpolateStepsContext` substitutes, so a check sees
 * exactly what launch interpolation left behind.
 */
export const TEMPLATE_PLACEHOLDER_SOURCE = String.raw`\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}`;

/** Distinct `{{param}}` tokens still present in a string. */
export function unresolvedTemplatePlaceholders(value: string): string[] {
  return [...new Set(value.match(new RegExp(TEMPLATE_PLACEHOLDER_SOURCE, 'g')) ?? [])];
}

export type PathRuleCode =
  | 'empty'
  | 'too-long'
  | 'too-deep'
  | 'segment-too-long'
  | 'nul'
  | 'control-char'
  | 'backslash'
  | 'unc'
  | 'absolute'
  | 'colon'
  | 'empty-segment'
  | 'dot-segment'
  | 'trailing-space-or-dot'
  | 'reserved-name'
  | 'template-placeholder';

export interface PathRuleOptions {
  /** Accept the empty string as the root. */
  allowRoot?: boolean;
  /** Whether a backslash separates segments (desktop) or is itself forbidden (portable). */
  separators: 'slash' | 'both';
  /** Let `.` and `..` through for a later resolver to contain. */
  allowDotSegments?: boolean;
  /** Let doubled separators through. */
  allowEmptySegments?: boolean;
  maxLength?: number;
  maxSegments?: number;
  maxSegmentBytes?: number;
  forbidAbsolute?: boolean;
  forbidColon?: boolean;
  /** Refuse every control character, not only NUL. */
  forbidControlChars?: boolean;
  forbidUnc?: boolean;
  forbidTemplate?: boolean;
}

export interface PathRuleViolation {
  code: PathRuleCode;
  segment?: string;
}

const encoder = new TextEncoder();

/**
 * The first rule a path breaks, or null. Checks run in a fixed order so a
 * host mapping codes to messages reports the same thing for the same input
 * regardless of which options it enables.
 */
export function findPathRuleViolation(
  path: string,
  options: PathRuleOptions,
): PathRuleViolation | null {
  if (typeof path !== 'string') return { code: 'empty' };
  if (options.maxLength !== undefined && path.length > options.maxLength)
    return { code: 'too-long' };
  if (!path) return options.allowRoot ? null : { code: 'empty' };
  if (path.includes('\0')) return { code: 'nul' };
  if (options.forbidUnc && path.startsWith('\\\\')) return { code: 'unc' };
  const segments = path.split(options.separators === 'both' ? /[\\/]+/ : '/');
  if (options.maxSegments !== undefined && segments.length > options.maxSegments)
    return { code: 'too-deep' };
  if (options.maxSegmentBytes !== undefined) {
    const long = segments.find((s) => encoder.encode(s).byteLength > options.maxSegmentBytes!);
    if (long !== undefined) return { code: 'segment-too-long', segment: long };
  }
  if (options.separators === 'slash' && path.includes('\\')) return { code: 'backslash' };
  if (options.forbidAbsolute && path.startsWith('/')) return { code: 'absolute' };
  if (options.forbidColon && path.includes(':')) return { code: 'colon' };
  if (options.forbidControlChars) {
    for (const character of path) {
      const code = character.charCodeAt(0);
      if (code < 32 || code === 127) return { code: 'control-char' };
    }
  }
  for (const segment of segments) {
    if (!segment) {
      if (options.allowEmptySegments) continue;
      return { code: 'empty-segment' };
    }
    if (segment === '.' || segment === '..') {
      if (options.allowDotSegments) continue;
      return { code: 'dot-segment', segment };
    }
    if (options.forbidColon && segment.includes(':')) return { code: 'colon', segment };
    if (/[ .]$/.test(segment)) return { code: 'trailing-space-or-dot', segment };
    if (isReservedWindowsName(segment)) return { code: 'reserved-name', segment };
  }
  if (options.forbidTemplate && new RegExp(TEMPLATE_PLACEHOLDER_SOURCE).test(path))
    return { code: 'template-placeholder' };
  return null;
}

/** A browser or Capacitor host: slash-only, relative, bounded, no traversal. */
export const PORTABLE_PATH_RULES: PathRuleOptions = {
  separators: 'slash',
  maxLength: 1024,
  maxSegments: 128,
  maxSegmentBytes: 255,
  forbidAbsolute: true,
  forbidColon: true,
  forbidControlChars: true,
  forbidTemplate: true,
};

/**
 * The desktop's per-segment screen. Traversal and containment are left to
 * `safeJoin` and `realpath`, which is why dot and empty segments pass here.
 */
export const DESKTOP_SEGMENT_RULES: PathRuleOptions = {
  separators: 'both',
  allowRoot: true,
  allowDotSegments: true,
  allowEmptySegments: true,
  forbidColon: true,
  forbidUnc: true,
};
