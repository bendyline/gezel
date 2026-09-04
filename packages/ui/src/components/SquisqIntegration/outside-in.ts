/**
 * Gezel host adapter for Squisq's outside-in document contract.
 *
 * The portable contract also lives in `@bendyline/squisq-formats/outside-in`;
 * this adapter is expressed through the already-pinned registry primitives so
 * Gezel can ship in lockstep without depending on an unpublished Squisq build.
 */

import { collectImagePaths, generateExternalHtml } from '@bendyline/squisq-formats/html';
import {
  type ConversionResult,
  type ConvertOptions,
  convert,
  defaultRegistry,
} from '@bendyline/squisq-formats/registry';
import { markdownToDoc } from '@bendyline/squisq/doc';
import {
  type MarkdownDocument,
  parseFrontmatter,
  parseMarkdown,
  setFrontmatterValues,
  splitFrontmatterBlock,
  stringifyMarkdown,
} from '@bendyline/squisq/markdown';
import { type ContentContainer, MemoryContentContainer } from '@bendyline/squisq/storage';

// CSV is a Gezel host extension to Squisq's rendered-document outside-in set:
// the visible source stays in the file tree, while the Markdown companion uses
// Squisq's threshold-aware data-container import. Large CSV/XLSX sources spill
// their original bytes into the companion and render as a virtualized data
// card instead of expanding thousands of rows into Markdown.
export const OUTSIDE_IN_FORMATS = ['html', 'docx', 'pdf', 'pptx', 'xlsx', 'csv'] as const;
export type OutsideInFormat = (typeof OUTSIDE_IN_FORMATS)[number];
export const OUTSIDE_IN_UPDATE_FROM_MARKDOWN_KEY = 'squisq-updatefrommarkdown';

const FORMATS = new Set<string>(OUTSIDE_IN_FORMATS);
const DATA_REFERENCE_EXTENSION_RE = /\.(?:csv|tsv|xlsx|parquet)$/i;

export interface OutsideInLayout {
  targetPath: string;
  format: OutsideInFormat;
  parentDirectory: string;
  stem: string;
  companionName: string;
  companionDirectory: string;
  markdownFilename: string;
  markdownPath: string;
  relativeTargetPath: string;
  backupDirectory: string;
  backupFilename: string;
  backupPath: string;
}

function normalizePath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`Outside-in paths must stay inside the project: ${path}`);
  }
  return parts.join('/');
}

function join(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

function slug(stem: string): string {
  return (
    stem
      .normalize('NFKD')
      .replace(/\p{Mark}+/gu, '')
      .toLocaleLowerCase('en-US')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'document'
  );
}

export function resolveOutsideInLayout(path: string): OutsideInLayout | null {
  const targetPath = normalizePath(path);
  const slash = targetPath.lastIndexOf('/');
  const parentDirectory = slash < 0 ? '' : targetPath.slice(0, slash);
  const filename = slash < 0 ? targetPath : targetPath.slice(slash + 1);
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  const rawFormat = filename.slice(dot + 1).toLowerCase();
  const format = rawFormat === 'htm' ? 'html' : rawFormat;
  if (!FORMATS.has(format)) return null;
  const stem = filename.slice(0, dot);
  const companionName = `${stem}_files`;
  const companionDirectory = join(parentDirectory, companionName);
  const markdownFilename = `${slug(stem)}.md`;
  const backupDirectory = join(companionDirectory, '.original');
  const backupFilename = `original.${format}`;
  return {
    targetPath,
    format: format as OutsideInFormat,
    parentDirectory,
    stem,
    companionName,
    companionDirectory,
    markdownFilename,
    markdownPath: join(companionDirectory, markdownFilename),
    relativeTargetPath: `../${filename}`,
    backupDirectory,
    backupFilename,
    backupPath: join(backupDirectory, backupFilename),
  };
}

export function chooseOutsideInSource(
  layout: OutsideInLayout,
  filePaths: readonly string[],
): string | null {
  const canonical = normalizePath(layout.markdownPath);
  const paths = filePaths.map(normalizePath);
  const exact = paths.find((path) => path === canonical);
  if (exact) return exact;
  const folded = paths.find(
    (path) => path.toLocaleLowerCase('en-US') === canonical.toLocaleLowerCase('en-US'),
  );
  if (folded) return folded;
  const prefix = `${layout.companionDirectory}/`;
  const markdown = paths.filter(
    (path) =>
      path.startsWith(prefix) &&
      !path.slice(prefix.length).includes('/') &&
      path.toLocaleLowerCase('en-US').endsWith('.md'),
  );
  return markdown.length === 1 ? markdown[0]! : null;
}

export function withOutsideInMetadata(markdown: string, layout: OutsideInLayout): string {
  const linked = setFrontmatterValues(markdown, {
    'squisq-outside-in': 1,
    'squisq-output': layout.relativeTargetPath,
    'squisq-output-format': layout.format,
  });
  return canonicalizeDataReferences(linked, layout.format);
}

function canonicalDataReferencePath(path: string): string {
  const unwrapped = path.startsWith('<') && path.endsWith('>') ? path.slice(1, -1) : path;
  let decoded = unwrapped;
  try {
    decoded = decodeURIComponent(unwrapped);
  } catch {
    // Keep malformed percent escapes intact; they are not safe to rewrite.
    return path;
  }
  if (!DATA_REFERENCE_EXTENSION_RE.test(decoded) || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(decoded)) {
    return path;
  }
  return decoded
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function canonicalizeDataReferences(markdown: string, format: OutsideInFormat): string {
  if (format !== 'csv' && format !== 'xlsx') return markdown;
  try {
    const document = parseMarkdown(markdown);
    let changed = false;
    for (const block of document.children) {
      const params = block.type === 'heading' ? block.templateAnnotation?.params : undefined;
      if (params && typeof params.src === 'string') {
        const current = params.src;
        const canonical = canonicalDataReferencePath(current);
        if (canonical !== current) {
          params.src = canonical;
          changed = true;
        }
      }
      if (block.type !== 'paragraph') continue;
      for (const inline of block.children) {
        if (inline.type !== 'link') continue;
        const canonical = canonicalDataReferencePath(inline.url);
        if (canonical !== inline.url) {
          inline.url = canonical;
          changed = true;
        }
      }
    }
    return changed ? stringifyMarkdown(document) : markdown;
  } catch {
    // Metadata repair should not make an otherwise readable companion fail.
    return markdown;
  }
}

function rawFrontmatter(source: string): string | null {
  const block = splitFrontmatterBlock(source).frontmatter;
  if (!block) return null;
  const firstBreak = block.indexOf('\n');
  if (firstBreak < 0) return null;
  return block.slice(firstBreak + 1).replace(/\r?\n---(?:\r?\n)?$/, '');
}

export function isOutsideInMarkdownEditingEnabled(markdown: string): boolean {
  const yaml = rawFrontmatter(markdown);
  const frontmatter = yaml === null ? null : parseFrontmatter(yaml);
  return frontmatter?.[OUTSIDE_IN_UPDATE_FROM_MARKDOWN_KEY] === true;
}

/**
 * CSV sidecars are edited in place by Squisq's data card, while Gezel's
 * outside-in save path regenerates the user-visible source from Markdown.
 * Until CSV export materializes `{[dataTable src=...]}` references, enabling
 * that path could replace the visible CSV with an empty export.
 */
export function supportsOutsideInMarkdownEditing(format: OutsideInFormat): boolean {
  return format !== 'csv';
}

export function withOutsideInMarkdownEditing(
  markdown: string,
  layout: OutsideInLayout,
  enabled = true,
): string {
  return setFrontmatterValues(withOutsideInMetadata(markdown, layout), {
    [OUTSIDE_IN_UPDATE_FROM_MARKDOWN_KEY]: enabled,
  });
}

function asArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export async function importOutsideInDocument(
  data: ArrayBuffer | Uint8Array,
  layout: OutsideInLayout,
  options: ConvertOptions = {},
): Promise<{ markdown: string; container: ContentContainer; warnings: string[] }> {
  const registry = options.registry ?? defaultRegistry();
  const definition = registry.get(layout.format);
  if (!definition || (!definition.importContainer && !definition.importDoc)) {
    throw new Error(`${layout.format.toUpperCase()} cannot be imported for editing.`);
  }
  // The spill-capable importers name both their Markdown document and their
  // `<doc-slug>_files/data/<source>` sidecar from `sourceName`. Without this,
  // every workbook became `workbook.md` and every CSV became `data.md`, which
  // also made multiple companions indistinguishable in the Files panel.
  const formatOptions =
    layout.format === 'xlsx' || layout.format === 'csv'
      ? {
          ...options.formatOptions,
          [layout.format]: {
            ...(options.formatOptions?.[layout.format] ?? {}),
            sourceName: basename(layout.targetPath),
          },
        }
      : options.formatOptions;
  const importOptions: ConvertOptions = {
    ...options,
    registry,
    from: layout.format,
    ...(formatOptions ? { formatOptions } : {}),
  };
  let container: ContentContainer = new MemoryContentContainer();
  let document: MarkdownDocument | null = null;
  if (definition.importContainer) {
    container = await definition.importContainer(asArrayBuffer(data), importOptions);
    const markdown = await container.readDocument();
    if (markdown !== null) document = parseMarkdown(markdown);
  }
  if (!document && definition.importDoc) {
    document = await definition.importDoc(asArrayBuffer(data), importOptions);
  }
  if (!document)
    throw new Error(`The ${layout.format.toUpperCase()} file has no editable content.`);
  const warnings: string[] = [];
  if (
    (layout.format === 'docx' || layout.format === 'xlsx') &&
    typeof document.frontmatter?.['squisq-theme'] !== 'string'
  ) {
    try {
      const [{ inferThemeFromFile }, themeCodec] = await Promise.all([
        import('@bendyline/squisq-formats/infer'),
        import('@bendyline/squisq/doc'),
      ]);
      const inferred = await inferThemeFromFile(asArrayBuffer(data), {
        format: layout.format,
        nameHint: layout.stem,
        signal: options.signal,
      });
      const payload = themeCodec.writeCustomThemesToFrontmatter([inferred.theme]);
      if (payload) {
        document.frontmatter = {
          ...(document.frontmatter ?? {}),
          [themeCodec.FRONTMATTER_CUSTOM_THEMES_KEY]: payload,
          'squisq-theme': inferred.theme.id,
        };
      }
      warnings.push(...inferred.warnings);
    } catch (error: unknown) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      warnings.push(
        `The ${layout.format.toUpperCase()} content was imported, but its Office theme could not be retained: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    markdown: withOutsideInMetadata(stringifyMarkdown(document), layout),
    container,
    warnings,
  };
}

export async function renderOutsideInDocument(
  markdown: string,
  layout: OutsideInLayout,
  container: ContentContainer,
  playerScriptPath?: string,
): Promise<ConversionResult> {
  if (!supportsOutsideInMarkdownEditing(layout.format)) {
    throw new Error('CSV data sidecar previews are read-only.');
  }
  if (!isOutsideInMarkdownEditingEnabled(markdown)) {
    throw new Error(
      `Outside-in editing is read-only until ${OUTSIDE_IN_UPDATE_FROM_MARKDOWN_KEY}: true is set.`,
    );
  }
  if (layout.format !== 'html') {
    return convert(
      { kind: 'markdown', markdown, container, baseName: layout.stem },
      layout.format,
      { title: layout.stem },
    );
  }
  if (!playerScriptPath) throw new Error('HTML editing needs a shared Squisq runtime path.');
  const doc = markdownToDoc(parseMarkdown(markdown));
  const mediaPath = (path: string) => `${layout.companionName}/${path.replace(/^\/+/, '')}`;
  const imagePathMap = Object.fromEntries(
    [...collectImagePaths(doc)].map((path) => [path, mediaPath(path)]),
  );
  const audioPathMap: Record<string, string> = {};
  for (const segment of doc.audio.segments) {
    audioPathMap[segment.name] = mediaPath(segment.src);
    audioPathMap[segment.src] = mediaPath(segment.src);
  }
  const html = generateExternalHtml(doc, {
    playerScriptPath,
    imagePathMap,
    audioPathMap,
    title: layout.stem,
    mode: 'static',
  });
  return {
    bytes: new TextEncoder().encode(html),
    mimeType: 'text/html',
    suggestedFilename: `${layout.stem}.html`,
    warnings: [],
  };
}

export function runtimePathForTarget(
  targetPath: string,
  directoryPaths: ReadonlySet<string>,
): string {
  let directory = parentPath(targetPath);
  for (;;) {
    const candidate = join(directory, '_squisq');
    if (directoryPaths.has(candidate)) return join(candidate, 'squisq-player.js');
    if (!directory) return '_squisq/squisq-player.js';
    directory = parentPath(directory);
  }
}

export function parentPath(path: string): string {
  const canonical = normalizePath(path);
  const slash = canonical.lastIndexOf('/');
  return slash < 0 ? '' : canonical.slice(0, slash);
}

export function relativePath(fromDirectory: string, targetPath: string): string {
  const from = normalizePath(fromDirectory).split('/').filter(Boolean);
  const target = normalizePath(targetPath).split('/').filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < target.length && from[shared] === target[shared])
    shared++;
  return [...from.slice(shared).map(() => '..'), ...target.slice(shared)].join('/') || '.';
}
