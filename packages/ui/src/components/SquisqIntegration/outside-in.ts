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
  parseMarkdown,
  setFrontmatterValues,
  stringifyMarkdown,
} from '@bendyline/squisq/markdown';
import { type ContentContainer, MemoryContentContainer } from '@bendyline/squisq/storage';

export const OUTSIDE_IN_FORMATS = ['html', 'docx', 'pdf', 'pptx', 'xlsx'] as const;
export type OutsideInFormat = (typeof OUTSIDE_IN_FORMATS)[number];

const FORMATS = new Set<string>(OUTSIDE_IN_FORMATS);

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
  return setFrontmatterValues(markdown, {
    'squisq-outside-in': 1,
    'squisq-output': layout.relativeTargetPath,
    'squisq-output-format': layout.format,
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
): Promise<{ markdown: string; container: ContentContainer }> {
  const registry = options.registry ?? defaultRegistry();
  const definition = registry.get(layout.format);
  if (!definition || (!definition.importContainer && !definition.importDoc)) {
    throw new Error(`${layout.format.toUpperCase()} cannot be imported for editing.`);
  }
  let container: ContentContainer = new MemoryContentContainer();
  let document: MarkdownDocument | null = null;
  if (definition.importContainer) {
    container = await definition.importContainer(asArrayBuffer(data), {
      ...options,
      registry,
      from: layout.format,
    });
    const markdown = await container.readDocument();
    if (markdown !== null) document = parseMarkdown(markdown);
  }
  if (!document && definition.importDoc) {
    document = await definition.importDoc(asArrayBuffer(data), {
      ...options,
      registry,
      from: layout.format,
    });
  }
  if (!document)
    throw new Error(`The ${layout.format.toUpperCase()} file has no editable content.`);
  return {
    markdown: withOutsideInMetadata(stringifyMarkdown(document), layout),
    container,
  };
}

export async function renderOutsideInDocument(
  markdown: string,
  layout: OutsideInLayout,
  container: ContentContainer,
  playerScriptPath?: string,
): Promise<ConversionResult> {
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

export function isOutsideInInternalPath(path: string): boolean {
  return normalizePath(path)
    .split('/')
    .some((part) => part === '_squisq' || part.toLocaleLowerCase('en-US').endsWith('_files'));
}
