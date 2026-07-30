/**
 * Execute an export through `@bendyline/squisq-formats` and trigger a
 * browser download. Ported (with light adaptation) from docblocks's
 * `run-export.ts`: same routing per format, same image-resolution
 * fall-through to a `ContentContainer`, same filename derivation.
 *
 * Filename rule (per gezel UX): always `<path-basename>.<ext>` — slashes
 * and the original extension are stripped. Bare path `"as"` exports as
 * `as.pdf`; `"notes/diary.md"` exports as `diary.pdf`.
 */

import { containerToZip } from '@bendyline/squisq-formats/container';
import { markdownDocToDocx } from '@bendyline/squisq-formats/docx';
import { collectImagePaths, docToHtml, docToHtmlZip } from '@bendyline/squisq-formats/html';
import { markdownDocToPdf } from '@bendyline/squisq-formats/pdf';
import { docToPptx } from '@bendyline/squisq-formats/pptx';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';
import { markdownToDoc } from '@bendyline/squisq/doc';
import type {
  MarkdownBlockNode,
  MarkdownDocument,
  MarkdownInlineNode,
} from '@bendyline/squisq/markdown';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { Doc } from '@bendyline/squisq/schemas';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { applyTransform } from '@bendyline/squisq/transform';
import type { ExportFormat, ExportOptions } from './export-options.js';
import { FORMAT_EXTENSIONS } from './export-options.js';

const MIME_TYPES: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
  html: 'text/html',
};

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Derive `<basename>.<ext>` from a path. Strips directories and the
 * original extension. Falls back to `document` when the path is null
 * or empty.
 */
function buildFilename(selectedFile: string | null, format: ExportFormat): string {
  if (!selectedFile) return `document${FORMAT_EXTENSIONS[format]}`;
  const tail = selectedFile.split('/').pop() ?? selectedFile;
  const base = tail.replace(/\.[^.]+$/, '') || 'document';
  return base + FORMAT_EXTENSIONS[format];
}

export async function runExport(
  markdown: string,
  selectedFile: string | null,
  options: ExportOptions,
  mediaContainer?: ContentContainer | null,
): Promise<void> {
  const filename = buildFilename(selectedFile, options.format);
  const themeId = options.themeId !== 'standard' ? options.themeId : undefined;

  if (options.format === 'md') {
    downloadBlob(new Blob([markdown], { type: MIME_TYPES.md }), filename);
    return;
  }

  if (options.format === 'html') {
    await runHtmlExport(markdown, filename, options, mediaContainer);
    return;
  }

  const doc = parseMarkdown(markdown);

  if (options.format === 'docx') {
    const images = mediaContainer ? await resolveImages(doc, mediaContainer) : undefined;
    const buf = await markdownDocToDocx(doc, { themeId, images });
    downloadBlob(new Blob([buf], { type: MIME_TYPES.docx }), filename);
    return;
  }

  if (options.format === 'pdf') {
    const buf = await markdownDocToPdf(doc, { themeId, pageSize: options.pageSize });
    downloadBlob(new Blob([buf], { type: MIME_TYPES.pdf }), filename);
    return;
  }

  if (options.format === 'pptx') {
    const baseDoc = markdownToDoc(doc);
    const transformed = applyTransform(baseDoc, options.transformStyle);
    const enrichedDoc = transformed.doc;
    if (themeId) enrichedDoc.themeId = themeId;
    const buf = await docToPptx(enrichedDoc, { themeId });
    downloadBlob(new Blob([buf], { type: MIME_TYPES.pptx }), filename);
    return;
  }
}

async function runHtmlExport(
  markdown: string,
  htmlFilename: string,
  options: ExportOptions,
  mediaContainer?: ContentContainer | null,
): Promise<void> {
  const baseName = htmlFilename.replace(/\.html$/, '');
  const zipName = `${baseName}.zip`;
  const themeId = options.themeId !== 'standard' ? options.themeId : undefined;

  if (options.htmlStyle === 'rendered') {
    const mdDoc = parseMarkdown(markdown);
    const baseDoc = markdownToDoc(mdDoc);
    if (themeId) baseDoc.themeId = themeId;
    const images = mediaContainer ? await resolveDocImages(baseDoc, mediaContainer) : undefined;
    if (options.htmlBundle === 'zip') {
      const blob = await docToHtmlZip(baseDoc, {
        playerScript: PLAYER_BUNDLE,
        images,
        mode: 'static',
        title: baseName,
      });
      downloadBlob(blob, zipName);
      return;
    }
    const html = docToHtml(baseDoc, {
      playerScript: PLAYER_BUNDLE,
      images,
      mode: 'static',
      title: baseName,
    });
    downloadBlob(new Blob([html], { type: MIME_TYPES.html }), htmlFilename);
    return;
  }

  // Plain semantic HTML
  const mdDoc = parseMarkdown(markdown);
  const referencedImages = collectMarkdownImageUrls(mdDoc);
  const localImages = referencedImages.filter((u) => !isExternalUrl(u));

  if (options.htmlBundle === 'zip' && mediaContainer && localImages.length > 0) {
    const html = renderPlainHtml(mdDoc, baseName, null);
    const container = new MemoryContentContainer();
    await container.writeFile('index.html', new TextEncoder().encode(html));
    for (const url of localImages) {
      const data = await mediaContainer.readFile(url);
      if (!data) continue;
      const cleanPath = url.replace(/^\/+/, '');
      await container.writeFile(cleanPath, new Uint8Array(data));
    }
    const blob = await containerToZip(container);
    downloadBlob(blob, zipName);
    return;
  }

  // Single-file plain HTML — embed local images as base64 data URIs.
  const inlineMap = new Map<string, string>();
  if (mediaContainer) {
    for (const url of localImages) {
      const data = await mediaContainer.readFile(url);
      if (!data) continue;
      inlineMap.set(url, arrayBufferToDataUrl(data, url));
    }
  }
  const html = renderPlainHtml(mdDoc, baseName, inlineMap);
  downloadBlob(new Blob([html], { type: MIME_TYPES.html }), htmlFilename);
}

function renderPlainHtml(
  doc: MarkdownDocument,
  title: string,
  imageMap: Map<string, string> | null,
): string {
  const body = doc.children.map((node) => nodeToHtml(node, imageMap)).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 2em auto; padding: 0 1em; line-height: 1.6; color: #1f2937; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  pre { background: #f3f4f6; padding: 1em; border-radius: 4px; overflow-x: auto; }
  code { background: #f3f4f6; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #d1d5db; margin-left: 0; padding-left: 1em; color: #6b7280; }
  img { max-width: 100%; }
  a { color: #3b82f6; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// biome-ignore lint/suspicious/noExplicitAny: markdown AST nodes are unioned; the recursive walker tolerates any leaf shape
function nodeToHtml(node: any, imageMap: Map<string, string> | null): string {
  if (!node) return '';
  switch (node.type) {
    case 'heading': {
      const tag = `h${node.depth ?? 1}`;
      return `<${tag}>${childrenToHtml(node, imageMap)}</${tag}>`;
    }
    case 'paragraph':
      return `<p>${childrenToHtml(node, imageMap)}</p>`;
    case 'text':
      return escapeHtml(node.value ?? '');
    case 'strong':
      return `<strong>${childrenToHtml(node, imageMap)}</strong>`;
    case 'emphasis':
      return `<em>${childrenToHtml(node, imageMap)}</em>`;
    case 'delete':
      return `<del>${childrenToHtml(node, imageMap)}</del>`;
    case 'inlineCode':
      return `<code>${escapeHtml(node.value ?? '')}</code>`;
    case 'code':
      return `<pre><code>${escapeHtml(node.value ?? '')}</code></pre>`;
    case 'blockquote':
      return `<blockquote>${childrenToHtml(node, imageMap)}</blockquote>`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      return `<${tag}>${childrenToHtml(node, imageMap)}</${tag}>`;
    }
    case 'listItem':
      return `<li>${childrenToHtml(node, imageMap)}</li>`;
    case 'link':
      return `<a href="${escapeAttr(node.url ?? '')}">${childrenToHtml(node, imageMap)}</a>`;
    case 'image': {
      const url = node.url ?? '';
      const resolved = imageMap?.get(url) ?? url;
      return `<img src="${escapeAttr(resolved)}" alt="${escapeAttr(node.alt ?? '')}" />`;
    }
    case 'thematicBreak':
      return '<hr />';
    default:
      return node.children ? childrenToHtml(node, imageMap) : escapeHtml(node.value ?? '');
  }
}

// biome-ignore lint/suspicious/noExplicitAny: see nodeToHtml — the walker handles any AST node
function childrenToHtml(node: any, imageMap: Map<string, string> | null): string {
  if (!node.children) return node.value ? escapeHtml(node.value) : '';
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return node.children.map((c: any) => nodeToHtml(c, imageMap)).join('');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

function isExternalUrl(url: string): boolean {
  return (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  );
}

function arrayBufferToDataUrl(data: ArrayBuffer, url: string): string {
  const ext = url.slice(url.lastIndexOf('.') + 1).toLowerCase();
  const mime = IMAGE_MIME[ext] ?? 'application/octet-stream';
  const bytes = new Uint8Array(data);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function collectMarkdownImageUrls(doc: MarkdownDocument): string[] {
  const urls: string[] = [];
  function walkBlocks(nodes: MarkdownBlockNode[]): void {
    for (const node of nodes) {
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children as (MarkdownBlockNode | MarkdownInlineNode)[]) {
          if (child.type === 'image') {
            urls.push((child as { url: string }).url);
          } else if ('children' in child && Array.isArray(child.children)) {
            walkBlocks(child.children as MarkdownBlockNode[]);
          }
        }
      }
    }
  }
  walkBlocks(doc.children);
  return Array.from(new Set(urls));
}

async function resolveImages(
  doc: MarkdownDocument,
  container: ContentContainer,
): Promise<Map<string, { data: ArrayBuffer | Uint8Array; contentType: string }>> {
  const urls = collectMarkdownImageUrls(doc);
  const map = new Map<string, { data: ArrayBuffer | Uint8Array; contentType: string }>();
  for (const url of urls) {
    if (map.has(url)) continue;
    if (isExternalUrl(url)) continue;
    const data = await container.readFile(url);
    if (!data) continue;
    const ext = url.slice(url.lastIndexOf('.') + 1).toLowerCase();
    const contentType = IMAGE_MIME[ext] || 'image/png';
    map.set(url, { data, contentType });
  }
  return map;
}

async function resolveDocImages(
  doc: Doc,
  container: ContentContainer,
): Promise<Map<string, ArrayBuffer>> {
  const paths = collectImagePaths(doc);
  const map = new Map<string, ArrayBuffer>();
  for (const path of paths) {
    const data = await container.readFile(path);
    if (!data) continue;
    map.set(path, data);
  }
  return map;
}
