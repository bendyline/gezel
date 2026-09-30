import { extractDirectFileWorkTargetPath } from './direct-file-work-prompt.js';
/**
 * Text-form immediate-write salvage, shared by the local engines.
 *
 * llama-cpp watches its stream and aborts the turn the moment a usable
 * `write_file` call has arrived — `ABORT-FIRED reason=immediate-write-text`.
 * MLX had no equivalent, so every turn generated to completion: measured
 * 2026-08-17 across 10 tictactoe/tankcombat trials, 41 turns ended with
 * toolCalls=0 at a median 136s each, 203 minutes of generation in total,
 * against llama-cpp cutting the same turn at 95s with the write in hand.
 *
 * The detector matters more than the byte threshold. Aborting on raw length
 * alone truncates a file mid-body; `hasSalvageableImmediateFileWriteContent`
 * only says yes once the salvaged content looks like a COMPLETE document
 * (or the hard ceiling is reached), which is what makes an early abort safe.
 *
 * Moved verbatim out of the llama-cpp provider — behaviour must stay
 * identical, so change it here rather than in either engine.
 */
import { isWriteShapedToolName } from './local-tool-call-salvage.js';

/** Hard ceiling: abort a text-form write turn once the raw content passes this. */
export const IMMEDIATE_FILE_WRITE_TEXT_ABORT_CHARS = 4_096;

export function cleanLooseWriteContentTail(raw: string): string | null {
  let out = raw;
  const pathSuffix = /(?:^|[,\s])["']?path["']?\s*:/i.exec(out);
  if (pathSuffix?.index !== undefined && pathSuffix.index > 0) {
    out = out.slice(0, pathSuffix.index);
  }
  out = out
    .replace(/\s*["']{3}\s*[,)]?\s*;?\s*$/s, '')
    .replace(/\s*["']\s*\}\s*\)?\s*;?\s*$/s, '')
    .replace(/\s*["']\s*[,)]?\s*;?\s*$/s, '')
    .trim();
  return out.length > 0 ? out : null;
}

export function isTrustworthyLooseHtmlPath(path: string): boolean {
  if (path.length === 0 || /^[,.:;'"`]+$/.test(path)) return false;
  return /\.html?$/i.test(path);
}

export function findLoosePathArg(text: string): { value: string; index: number } | null {
  const patterns = [
    /(?:^|[,{(\s])["']?path["']?\s*:\s*["']([^"'\r\n]{1,260})["']/i,
    /(?:^|[,{(\s])["']?name["']?\s*:\s*["']([^"'\r\n]{1,260})["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1] && m.index >= 0) return { value: m[1], index: m.index };
  }
  return null;
}

export function findLooseWriteContent(text: string): string | null {
  const contentKey = /(?:^|[,{(\s])["']?content["']?\s*:\s*["']/i.exec(text);
  if (contentKey?.index !== undefined) {
    const start = contentKey.index + contentKey[0].length;
    return cleanLooseWriteContentTail(text.slice(start));
  }

  const path = findLoosePathArg(text);
  const beforePath = path ? text.slice(0, path.index) : text;
  const htmlStart = firstExistingIndex(beforePath, ['<!DOCTYPE', '<html', '<!doctype']);
  if (htmlStart >= 0) return cleanLooseWriteContentTail(beforePath.slice(htmlStart));

  const trimmed = beforePath.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return cleanLooseWriteContentTail(trimmed.slice(1));
  }
  return null;
}

export function normalizeLooseWritePath(value: string | undefined, content: string): string | null {
  const trimmed = value?.trim() ?? '';
  if (looksLikeLooseSingleFileHtml(content)) {
    if (isTrustworthyLooseHtmlPath(trimmed)) return trimmed;
    return null;
  }
  if (trimmed.length > 0 && !/^[,.:;'"`]+$/.test(trimmed)) return trimmed;
  return null;
}

export function looksLikeLooseSingleFileHtml(content: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(content) && /<script[\s>]/i.test(content);
}

export function firstExistingIndex(text: string, needles: string[]): number {
  let best = -1;
  const lower = text.toLowerCase();
  for (const needle of needles) {
    const idx = lower.indexOf(needle.toLowerCase());
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

export function cutAtFirstToolLeak(text: string): string {
  const markers = ['<|channel', '<channel|>', '<|tool_call', '<tool_call|>', '<|end|>'];
  const idx = firstExistingIndex(text, markers);
  return idx >= 0 ? text.slice(0, idx) : text;
}

export function looseUnescapeToolArgumentText(raw: string): string {
  return raw
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

export function tryRepairMalformedWriteToolArguments(
  toolName: string,
  rawArguments: string,
  knownToolNames: ReadonlySet<string>,
): { path: string; content: string } | null {
  if (!toolName || !knownToolNames.has(toolName)) return null;
  if (!isWriteShapedToolName(toolName)) return null;
  if (!rawArguments.trim()) return null;

  const decoded = cutAtFirstToolLeak(looseUnescapeToolArgumentText(rawArguments));
  const path = findLoosePathArg(decoded);
  const content = findLooseWriteContent(decoded);
  if (!content || content.length < 20) return null;
  const normalizedPath = normalizeLooseWritePath(path?.value, content);
  if (!normalizedPath) return null;
  return { path: normalizedPath, content };
}

export function immediateFileWritePathFromPrompt(prompt: string): string | null {
  const explicit = /write_file\s*\(\s*\{\s*path\s*:\s*["']([^"']+)["']/i.exec(prompt)?.[1];
  return explicit ?? extractDirectFileWorkTargetPath(prompt);
}

export function salvageImmediateFileWriteArgs(
  rawContent: string,
  prompt: string,
  targetPath?: string,
): { path: string; content: string } | null {
  const loose = tryRepairMalformedWriteToolArguments(
    'write_file',
    rawContent,
    new Set(['write_file']),
  );
  if (loose) return loose;

  const cleaned = cutAtFirstToolLeak(looseUnescapeToolArgumentText(rawContent));
  const htmlStart = firstExistingIndex(cleaned, ['<!doctype html', '<!DOCTYPE html', '<html']);
  if (htmlStart < 0) return null;
  let content = cleaned.slice(htmlStart).trim();
  const htmlEnd = content.toLowerCase().lastIndexOf('</html>');
  if (htmlEnd >= 0) content = content.slice(0, htmlEnd + '</html>'.length).trim();
  if (!looksLikeLooseSingleFileHtml(content)) return null;
  const path = targetPath ?? immediateFileWritePathFromPrompt(prompt);
  return path ? { path, content } : null;
}

export function hasSalvageableImmediateFileWriteContent(
  rawContent: string,
  prompt: string,
): boolean {
  const salvaged = salvageImmediateFileWriteArgs(rawContent, prompt);
  if (!salvaged) return false;
  return (
    /<\/html>\s*$/i.test(salvaged.content) ||
    rawContent.length >= IMMEDIATE_FILE_WRITE_TEXT_ABORT_CHARS
  );
}
