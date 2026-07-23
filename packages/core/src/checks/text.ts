/**
 * Text/structure checks: distinct-match counting, ordered Markdown
 * sections, JSON validity. Ported from evals/src/success-check.ts
 * (incident-postmortem's citation + section rules).
 */

import type { CheckResult, WorkspaceLike } from './types.js';

export type JsonScalar = string | number | boolean | null;

export interface JsonPathEqualsResult extends CheckResult {
  actual?: unknown;
}

/**
 * Count DISTINCT regex matches in `text` (distinct by capture group 1
 * when present, else by the whole match, case-insensitive). A file cited
 * six times counts once.
 */
export function countDistinctMatches(text: string, pattern: RegExp): number {
  const seen = new Set<string>();
  const re = pattern.flags.includes('g')
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
  for (const m of text.matchAll(re)) {
    const key = (m[1] ?? m[0]).toLowerCase();
    if (key.length > 0) seen.add(key);
  }
  return seen.size;
}

/**
 * Verify `text` contains each header in `headers` IN ORDER (later
 * headers must appear AFTER earlier ones). Headers match `^#+\s+<h>$`
 * (case-insensitive, multi-line) — `#`/`##`/`###` all qualify.
 */
export function requireOrderedSections(
  text: string,
  headers: readonly string[],
): { ok: true } | { ok: false; missing: string; foundIndex: number } {
  let cursor = 0;
  for (const header of headers) {
    const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^#+\\s+${escaped}\\s*$`, 'im');
    const slice = text.slice(cursor);
    const m = slice.match(re);
    if (!m || m.index === undefined) {
      return { ok: false, missing: header, foundIndex: cursor };
    }
    cursor += m.index + m[0].length;
  }
  return { ok: true };
}

export function jsonValid(content: string): { ok: boolean; error?: string } {
  try {
    JSON.parse(content);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseJsonPath(path: string): Array<string | number> | null {
  const trimmed = path.trim().replace(/^\$\.?/, '');
  if (trimmed.length === 0) return [];

  const parts: Array<string | number> = [];
  for (const rawPart of trimmed.split('.')) {
    if (rawPart.length === 0) return null;
    const keyMatch = rawPart.match(/^[^\[\]]+/);
    if (keyMatch) parts.push(keyMatch[0] as string);
    const rest = rawPart.slice(keyMatch?.[0].length ?? 0);
    if (rest.length === 0) continue;
    const bracketRe = /\[(\d+)\]/g;
    let consumed = '';
    for (const match of rest.matchAll(bracketRe)) {
      consumed += match[0];
      parts.push(Number(match[1]));
    }
    if (consumed !== rest) return null;
  }
  return parts;
}

function getPathValue(root: unknown, path: Array<string | number>): unknown {
  let cursor = root;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(cursor) || part >= cursor.length) return undefined;
      cursor = cursor[part];
      continue;
    }
    if (cursor === null || typeof cursor !== 'object' || !(part in cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function printableValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export async function jsonPathEquals(
  ws: WorkspaceLike,
  file: string,
  path: string,
  expected: JsonScalar,
  label?: string,
): Promise<JsonPathEqualsResult> {
  const content = await ws.read(file);
  if (content === null) {
    return { ok: false, detail: `${file} not found`, actual: undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${file} is not valid JSON: ${detail}`, actual: undefined };
  }

  const parts = parseJsonPath(path);
  if (parts === null) {
    return { ok: false, detail: `${path} is not a supported JSON path`, actual: undefined };
  }

  const actual = getPathValue(parsed, parts);
  if (Object.is(actual, expected)) {
    return { ok: true, detail: `${file} ${path} equals ${printableValue(expected)}`, actual };
  }

  const guidance = label ? `: ${label}` : '';
  return {
    ok: false,
    detail: `${file} ${path} should equal ${printableValue(expected)} but was ${printableValue(actual)}${guidance}`,
    actual,
  };
}
