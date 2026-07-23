import type { FileContextResponse, SymbolContext } from '../schemas/api.js';

/**
 * Pure facts→markdown composer for the per-symbol context sections shown in
 * file viewers. Consumed by two hosts — the Map tab's embedded squisq editor
 * (Monaco view zones) and the vscode extension (CodeLens/Hover) — so it emits
 * host-neutral markdown plus a plain-text strip variant, and links use the
 * gezel href grammar below, which each host translates to its own navigation.
 *
 * Link grammar (the single source of truth both hosts parse):
 *   - cross-file: `gezel-nav:` + encodeURIComponent(workspaceRelativePath)
 *     + optional `#L<line>`
 *   - in-file:    bare fragment `#L<line>`
 */

export type GezelHref =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'line'; line: number };

/** One composed section, structurally spreadable into squisq's CodeContextSection. */
export interface ComposedSection {
  id: string;
  /** 1-based line the section renders above (the symbol's lineStart). */
  line: number;
  /** One-line markdown strip (no links). */
  summaryMarkdown: string;
  /** The strip as plain text — CodeLens titles can't render markdown. */
  summaryText: string;
  /** Expanded body markdown. */
  markdown: string;
  defaultExpanded?: boolean;
}

export interface ComposedCodeContext {
  fileTop?: { id: string; summaryMarkdown: string; summaryText: string; markdown: string };
  sections: ComposedSection[];
}

// Display caps — the service already caps the facts; these bound the rendering.
const SHOW_IMPORTED_BY = 8;
const SHOW_USES = 12;
const SHOW_USED_IN_FILE_BY = 8;
const SHOW_FINDINGS = 10;
const STRIP_SUMMARY_CHARS = 100;

export function gezelNavHref(path: string, line?: number): string {
  return `gezel-nav:${encodeURIComponent(path)}${line ? `#L${line}` : ''}`;
}

export function gezelLineHref(line: number): string {
  return `#L${line}`;
}

/** Parse a gezel href; null for anything outside the grammar (http:, #foo, …). */
export function parseGezelHref(href: string): GezelHref | null {
  const lineOnly = /^#L(\d+)$/.exec(href);
  if (lineOnly) return { kind: 'line', line: Number(lineOnly[1]) };
  if (!href.startsWith('gezel-nav:')) return null;
  const rest = href.slice('gezel-nav:'.length);
  const hash = rest.lastIndexOf('#L');
  const encoded = hash >= 0 ? rest.slice(0, hash) : rest;
  const lineStr = hash >= 0 ? rest.slice(hash + 2) : '';
  if (hash >= 0 && !/^\d+$/.test(lineStr)) return null;
  let path: string;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!path) return null;
  return { kind: 'file', path, ...(hash >= 0 ? { line: Number(lineStr) } : {}) };
}

/**
 * Rewrite every gezel-grammar link destination in composed markdown via `fn`
 * (e.g. to vscode `command:` URIs). Non-gezel links are left untouched. Only
 * safe on markdown THIS module composed — it never emits the `](...)` pattern
 * inside code fences.
 */
export function rewriteGezelHrefs(markdown: string, fn: (href: GezelHref) => string): string {
  return markdown.replace(/\]\((gezel-nav:[^)\s]+|#L\d+)\)/g, (whole, href: string) => {
    const parsed = parseGezelHref(href);
    return parsed ? `](${fn(parsed)})` : whole;
  });
}

/** Escape text destined for markdown prose (names, titles, summaries). */
export function escapeMd(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

export function composeFileContext(res: FileContextResponse): ComposedCodeContext {
  if (res.engine === 'unavailable' || (res.symbols.length === 0 && !res.summary)) {
    return { sections: [] };
  }
  const lineOf = new Map<string, number>();
  for (const s of res.symbols) if (!lineOf.has(s.name)) lineOf.set(s.name, s.lineStart);

  const sections = res.symbols.map((s) => composeSymbolSection(s, res, lineOf));
  const fileTop = composeFileTop(res);
  return { ...(fileTop ? { fileTop } : {}), sections };
}

function composeSymbolSection(
  s: SymbolContext,
  res: FileContextResponse,
  lineOf: Map<string, number>,
): ComposedSection {
  const label = s.parent ? `${s.parent}.${s.name}` : s.name;
  const gist = s.summary ? truncate(s.summary, STRIP_SUMMARY_CHARS) : s.kind;

  const chips: string[] = [];
  if (s.importedBy.length > 0) {
    chips.push(`↓${s.importedBy.length}${s.importedByTruncated ? '+' : ''} imported-by`);
  }
  if (s.uses.length > 0) chips.push(`↑${s.uses.length} uses`);
  if (s.usedInFileBy.length > 0) chips.push(`○${s.usedInFileBy.length} in-file`);
  if (s.findings.length > 0) {
    chips.push(`⚠ ${s.findings.length} finding${s.findings.length === 1 ? '' : 's'}`);
  }
  const tail = chips.length ? ` · ${chips.join(' · ')}` : '';
  const summaryMarkdown = `**${escapeMd(label)}** — ${escapeMd(gist)}${tail}`;
  const summaryText = `${label} — ${gist}${tail}`;

  const blocks: string[] = [];
  if (s.summary) blocks.push(escapeMd(s.summary));
  if (s.signature) blocks.push(fence(s.signature, langFence(res.path)));

  if (s.importedBy.length > 0) {
    const shown = s.importedBy.slice(0, SHOW_IMPORTED_BY);
    const lines = shown.map(
      (i) =>
        `- [\`${i.path}\`](${gezelNavHref(i.path)})${i.viaBinding ? '' : ' — whole-file import'}`,
    );
    blocks.push(
      listBlock(
        `Imported by (${s.importedBy.length}${s.importedByTruncated ? '+' : ''})`,
        lines,
        s.importedBy.length - shown.length,
        s.importedByTruncated,
      ),
    );
  }

  if (s.uses.length > 0) {
    const shown = s.uses.slice(0, SHOW_USES);
    const lines = shown.map((u) =>
      u.inRepo
        ? `- [\`${u.name}\`](${gezelNavHref(u.from)}) — \`${u.from}\``
        : `- \`${u.name}\` — \`${u.from}\``,
    );
    blocks.push(listBlock(`Uses (${s.uses.length})`, lines, s.uses.length - shown.length, false));
  }

  if (s.usedInFileBy.length > 0) {
    const shown = s.usedInFileBy.slice(0, SHOW_USED_IN_FILE_BY);
    const lines = shown.map((name) => {
      const line = lineOf.get(name);
      return line ? `- [\`${name}\`](${gezelLineHref(line)}) — line ${line}` : `- \`${name}\``;
    });
    blocks.push(
      listBlock(
        `Used in this file by (${s.usedInFileBy.length})`,
        lines,
        s.usedInFileBy.length - shown.length,
        false,
      ),
    );
  }

  if (s.findings.length > 0) {
    blocks.push(findingsBlock('Findings', s.findings));
  }

  return {
    id: `${s.name}@${s.lineStart}`,
    line: s.lineStart,
    summaryMarkdown,
    summaryText,
    markdown: blocks.join('\n\n'),
    defaultExpanded: false,
  };
}

function composeFileTop(res: FileContextResponse): ComposedCodeContext['fileTop'] {
  const basename = res.path.slice(res.path.lastIndexOf('/') + 1);
  const gist = res.summary
    ? truncate(res.summary, STRIP_SUMMARY_CHARS)
    : `${res.symbols.length} symbol${res.symbols.length === 1 ? '' : 's'}`;

  const chips: string[] = [];
  if (res.importedBy.length > 0) {
    chips.push(`↓${res.importedBy.length}${res.importedByTruncated ? '+' : ''} imported-by`);
  }
  if (res.imports.length > 0) chips.push(`↑${res.imports.length} imports`);
  const allFindings =
    res.fileFindings.length + res.symbols.reduce((n, s) => n + s.findings.length, 0);
  if (allFindings > 0) chips.push(`⚠ ${allFindings} finding${allFindings === 1 ? '' : 's'}`);
  const tail = chips.length ? ` · ${chips.join(' · ')}` : '';

  const blocks: string[] = [];
  if (res.summary) blocks.push(escapeMd(res.summary));

  if (res.imports.length > 0) {
    const shown = res.imports.slice(0, SHOW_USES);
    const lines = shown.map((imp) => {
      const names = imp.names.length ? ` — \`${imp.names.join('`, `')}\`` : '';
      return imp.resolvedPath
        ? `- [\`${imp.resolvedPath}\`](${gezelNavHref(imp.resolvedPath)})${names}`
        : `- \`${imp.specifier}\`${names}`;
    });
    blocks.push(
      listBlock(`Imports (${res.imports.length})`, lines, res.imports.length - shown.length, false),
    );
  }

  if (res.importedBy.length > 0) {
    const shown = res.importedBy.slice(0, SHOW_IMPORTED_BY);
    const lines = shown.map((i) => {
      const names = i.names.length ? ` — \`${i.names.join('`, `')}\`` : '';
      return `- [\`${i.path}\`](${gezelNavHref(i.path)})${names}`;
    });
    blocks.push(
      listBlock(
        `Imported by (${res.importedBy.length}${res.importedByTruncated ? '+' : ''})`,
        lines,
        res.importedBy.length - shown.length,
        res.importedByTruncated,
      ),
    );
  }

  if (res.fileFindings.length > 0) {
    blocks.push(findingsBlock('File findings', res.fileFindings));
  }

  if (blocks.length === 0 && chips.length === 0) return undefined;
  return {
    id: 'file',
    summaryMarkdown: `\`${basename}\` — ${escapeMd(gist)}${tail}`,
    summaryText: `${basename} — ${gist}${tail}`,
    markdown: blocks.join('\n\n'),
  };
}

function findingsBlock(
  title: string,
  findings: Array<{ severity: string; title: string; line: number | null }>,
): string {
  const shown = findings.slice(0, SHOW_FINDINGS);
  const lines = shown.map((f) => {
    const at = f.line != null ? ` ([line ${f.line}](${gezelLineHref(f.line)}))` : '';
    return `- ⚠ **${f.severity}** — ${escapeMd(f.title)}${at}`;
  });
  return listBlock(`${title} (${findings.length})`, lines, findings.length - shown.length, false);
}

function listBlock(heading: string, lines: string[], hidden: number, truncated: boolean): string {
  const tail =
    hidden > 0 || truncated ? `\n- … and ${Math.max(hidden, 0)}${truncated ? '+' : ''} more` : '';
  return `**${heading}**\n${lines.join('\n')}${tail}`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > max * 0.6 ? space : max)}…`;
}

const FENCE_LANG: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  lua: 'lua',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
};

function langFence(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  return FENCE_LANG[path.slice(dot + 1).toLowerCase()] ?? '';
}

function fence(code: string, lang: string): string {
  // A signature containing ``` needs a longer fence to stay contained.
  const ticks = code.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${code}\n${ticks}`;
}
