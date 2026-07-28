/**
 * Small repairs for recoverable model output quirks before workspace writes.
 *
 * Keep this narrow: source validation still owns rejecting broken code. These
 * transforms only cover patterns where the intended file is unambiguous.
 */

import { validateSourceContent } from './source-validation.js';

export function normalizeWorkspaceWriteContent(path: string, content: string): string {
  // `read_file` renders source with an `N→` display gutter so models can use
  // replace_lines. Small local models occasionally copy that rendered view
  // verbatim into a complete write_file draft. Strip it only when EVERY line
  // carries the exact monotonically increasing 1..N sequence: that signature
  // is produced by our renderer and is unambiguous. A partial/non-sequential
  // arrow prefix is left untouched for source validation to reject normally.
  let next = stripExactReadFileGutters(path, content);
  if (!isHtmlPath(path)) return next;

  next = next.replace(/\.\s*innerTextText\b/g, '.innerText');
  next = next.replace(
    /\bthis(?:\u{1f3fb}|\u{1f3fc}|\u{1f3fd}|\u{1f3fe}|\u{1f3ff}|\ufe0f)+\./gu,
    'this.',
  );
  next = next.replace(/\bthiss\./g, 'this.');
  next = next.replace(/\bMath\.\s*serat\s*\(/g, 'Math.max(');
  next = next.replace(/\bplayerice\./g, 'player.');
  next = next.replace(/\bprojectile\.splice\b/g, 'projectiles.splice');
  next = stripLeakedToolSuffixAfterHtmlClose(next);
  next = repairExtraIfConditionCloseParen(next);
  next = repairRecoverableInlineScriptSyntax(path, next);
  next = repairExtraBlockCallClosers(path, next);
  return next;
}

const GUTTER_SAFE_SOURCE_PATH_RE = /\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json)$/i;

/**
 * Remove a full-file copy of read_file's display-only line-number gutter.
 * Leading alignment spaces are optional because models sometimes trim the
 * first one while preserving the numeric sequence. Newline bytes and a final
 * newline are preserved exactly.
 */
export function stripExactReadFileGutters(path: string, content: string): string {
  if (!GUTTER_SAFE_SOURCE_PATH_RE.test(path) || !content.includes('→')) return content;

  const hadTrailingNewline = content.endsWith('\n');
  const body = hadTrailingNewline ? content.slice(0, -1) : content;
  if (!body) return content;

  const lines = body.split('\n');
  const stripped: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^[ \t]*(\d+)→/u.exec(lines[index]!);
    if (!match || Number(match[1]) !== index + 1) return content;
    stripped.push(lines[index]!.slice(match[0].length));
  }

  const normalized = stripped.join('\n');
  return hadTrailingNewline ? `${normalized}\n` : normalized;
}

function isHtmlPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function stripLeakedToolSuffixAfterHtmlClose(html: string): string {
  const lower = html.toLowerCase();
  const closeIndex = lower.lastIndexOf('</html>');
  if (closeIndex < 0) return html;

  const end = closeIndex + '</html>'.length;
  const tail = html.slice(end);
  if (!looksLikeLeakedToolSuffix(tail)) return html;
  return html.slice(0, end);
}

function looksLikeLeakedToolSuffix(tail: string): boolean {
  const trimmed = tail.trim();
  if (trimmed.length === 0) return false;
  if (!/^(?:"{3}|'{3})/.test(trimmed)) return false;
  return /(?:^|,)\s*["']?path["']?\s*:/.test(trimmed) || trimmed === '"""' || trimmed === "'''";
}

function repairExtraIfConditionCloseParen(html: string): string {
  const lines = html.split(/\r?\n/);
  const newline = html.includes('\r\n') ? '\r\n' : '\n';
  let changed = false;
  const repaired = lines.map((line) => {
    const next = removeExtraIfConditionCloseParen(line);
    if (next !== line) changed = true;
    return next;
  });
  if (!changed) return html;

  return repaired.join(newline);
}

function removeExtraIfConditionCloseParen(line: string): string {
  let next = line;
  let searchFrom = 0;
  while (true) {
    const ifIndex = next.indexOf('if', searchFrom);
    if (ifIndex < 0) return next;
    const prefix = next.slice(0, ifIndex);
    const beforeIf = prefix[prefix.length - 1];
    const afterIf = next[ifIndex + 2];
    if ((beforeIf && /[\w$]/.test(beforeIf)) || !/\s/.test(afterIf ?? '')) {
      searchFrom = ifIndex + 2;
      continue;
    }

    const openIndex = next.indexOf('(', ifIndex + 2);
    if (openIndex < 0) return next;
    const closeIndex = findMatchingParen(next, openIndex);
    if (closeIndex < 0) {
      searchFrom = openIndex + 1;
      continue;
    }

    const afterCondition = next.slice(closeIndex + 1).match(/^\s*/)?.[0] ?? '';
    const extraIndex = closeIndex + 1 + afterCondition.length;
    if (next[extraIndex] === ')') {
      next = next.slice(0, extraIndex) + next.slice(extraIndex + 1);
      searchFrom = ifIndex + 2;
      continue;
    }
    searchFrom = closeIndex + 1;
  }
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface LineRepairCandidate {
  apply(lines: string[]): string[];
}

function repairRecoverableInlineScriptSyntax(path: string, html: string): string {
  const before = validateSourceContent(path, html);
  if (!before || before.ok) return html;

  const split = splitLines(html);
  const candidates: LineRepairCandidate[] = [];

  if (/Unexpected token '\)'/.test(before.message)) {
    split.lines.forEach((line, index) => {
      const repaired = line.replace(
        /^(\s*(?:(?:const|let|var)\s+[\w$]+|[\w$.]+)\s*(?:[-+*/%]?=)\s*.+)\);(\s*)$/,
        '$1;$2',
      );
      if (repaired !== line) {
        candidates.push({
          apply(lines) {
            const next = [...lines];
            next[index] = repaired;
            return next;
          },
        });
      }

      const arrowRepaired = line.replace(
        /^(\s*[\w$.]+\.forEach\(\s*\([^)]*\))\)\s*\{\s*$/,
        '$1 => {',
      );
      if (arrowRepaired !== line) {
        candidates.push({
          apply(lines) {
            const next = [...lines];
            next[index] = arrowRepaired;
            return next;
          },
        });
      }
    });
  }

  if (html.includes('\\"')) {
    candidates.push({
      apply(lines) {
        return lines.map((line) => line.replace(/\\"/g, '"'));
      },
    });
  }

  if (candidates.length === 0 || candidates.length > 12) return html;

  const combinations = 1 << candidates.length;
  for (let repairs = 1; repairs <= candidates.length; repairs++) {
    for (let mask = 1; mask < combinations; mask++) {
      if (bitCount(mask) !== repairs) continue;
      let lines = [...split.lines];
      for (let bit = 0; bit < candidates.length; bit++) {
        if ((mask & (1 << bit)) === 0) continue;
        lines = candidates[bit]!.apply(lines);
      }
      const candidateHtml = lines.join(split.newline);
      if (validateSourceContent(path, candidateHtml)?.ok) return candidateHtml;
    }
  }

  return html;
}

function repairExtraBlockCallClosers(path: string, html: string): string {
  const before = validateSourceContent(path, html);
  if (!before || before.ok || !/Unexpected token '\)'/.test(before.message)) return html;

  const split = splitLines(html);
  const lines = split.lines.map((line) => line.replace(/^(\s*)\}\);\s*\}\);\s*$/, '$1});'));
  const doubleCandidate = lines.join(split.newline);
  if (doubleCandidate !== html && validateSourceContent(path, doubleCandidate)?.ok) {
    return doubleCandidate;
  }

  const closeCallLines: number[] = [];
  lines.forEach((line, index) => {
    if (/^\s*\}\);\s*$/.test(line)) closeCallLines.push(index);
  });
  if (closeCallLines.length === 0 || closeCallLines.length > 12) return doubleCandidate;

  const combinations = 1 << closeCallLines.length;
  for (let mask = combinations - 1; mask > 0; mask--) {
    const candidateLines = [...lines];
    for (let bit = 0; bit < closeCallLines.length; bit++) {
      if ((mask & (1 << bit)) === 0) continue;
      const lineIndex = closeCallLines[bit]!;
      const indent = candidateLines[lineIndex]!.match(/^\s*/)?.[0] ?? '';
      candidateLines[lineIndex] = `${indent}}`;
    }
    const candidate = candidateLines.join(split.newline);
    if (validateSourceContent(path, candidate)?.ok) return candidate;
  }

  return doubleCandidate;
}

function bitCount(value: number): number {
  let count = 0;
  let remaining = value;
  while (remaining > 0) {
    count += remaining & 1;
    remaining >>= 1;
  }
  return count;
}

function splitLines(text: string): { lines: string[]; newline: string } {
  return {
    lines: text.split(/\r?\n/),
    newline: text.includes('\r\n') ? '\r\n' : '\n',
  };
}
