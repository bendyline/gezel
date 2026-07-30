/**
 * Export option types + persistence for the "quick-export" shortcut.
 *
 * localStorage is the immediate cache. Gezel config is the durable source of
 * truth because the embedded daemon can bind a different loopback port each
 * launch, which changes the browser origin and strands localStorage.
 */

import { api } from '../../api.js';

export type ExportFormat = 'docx' | 'pdf' | 'pptx' | 'md' | 'html';

/** Visual style for HTML export. */
export type HtmlStyle =
  /** Render via SquisqPlayer (themed, embeds player bundle). */
  | 'rendered'
  /** Plain semantic HTML — small, no JS, no playback. */
  | 'plain';

/** Packaging for HTML export. */
export type HtmlBundle =
  /** Single self-contained .html file (images base64-embedded). */
  | 'single'
  /** ZIP containing index.html + asset files. */
  | 'zip';

export interface ExportOptions {
  format: ExportFormat;
  themeId: string;
  /** Transform style for PPTX — controls how content is segmented and styled. */
  transformStyle: string;
  /** Only applies to PDF */
  pageSize: 'letter' | 'a4';
  /** HTML rendering style. Only applies to format=html. */
  htmlStyle: HtmlStyle;
  /** HTML bundle layout. Only applies to format=html. */
  htmlBundle: HtmlBundle;
}

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  docx: 'Word Document (.docx)',
  pdf: 'PDF (.pdf)',
  pptx: 'PowerPoint (.pptx)',
  md: 'Markdown (.md)',
  html: 'HTML (.html)',
};

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  docx: '.docx',
  pdf: '.pdf',
  pptx: '.pptx',
  md: '.md',
  html: '.html',
};

const STORAGE_KEY = 'gezel-export-options';

export const DEFAULT_OPTIONS: ExportOptions = {
  format: 'pdf',
  themeId: 'standard',
  transformStyle: 'documentary',
  pageSize: 'letter',
  htmlStyle: 'plain',
  htmlBundle: 'single',
};

const FORMATS = new Set<ExportFormat>(['docx', 'pdf', 'pptx', 'md', 'html']);
const PAGE_SIZES = new Set<ExportOptions['pageSize']>(['letter', 'a4']);
const HTML_STYLES = new Set<HtmlStyle>(['rendered', 'plain']);
const HTML_BUNDLES = new Set<HtmlBundle>(['single', 'zip']);

export function normalizeExportOptions(value: unknown): ExportOptions | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<ExportOptions>;
  if (!parsed.format || !FORMATS.has(parsed.format)) return null;

  const merged = { ...DEFAULT_OPTIONS, ...parsed };
  if (
    typeof merged.themeId !== 'string' ||
    !merged.themeId ||
    typeof merged.transformStyle !== 'string' ||
    !merged.transformStyle ||
    !PAGE_SIZES.has(merged.pageSize) ||
    !HTML_STYLES.has(merged.htmlStyle) ||
    !HTML_BUNDLES.has(merged.htmlBundle)
  ) {
    return null;
  }
  return merged;
}

function cacheExportOptions(options: ExportOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // ignore quota / privacy-mode failures
  }
}

export function loadLastExportOptions(): ExportOptions | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeExportOptions(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveExportOptions(options: ExportOptions): Promise<void> {
  cacheExportOptions(options);
  await api.updateConfig({ documentExportOptions: options }).catch(() => {});
}

/**
 * Reconcile the current-origin cache with the durable server preference.
 * A missing/unreachable server preserves the local cache so browser-only
 * development and short boot races remain usable.
 */
export async function syncLastExportOptions(): Promise<ExportOptions | null> {
  const cached = loadLastExportOptions();
  try {
    const config = await api.getConfig();
    const durable = normalizeExportOptions(config.documentExportOptions);
    if (!durable) return cached;
    cacheExportOptions(durable);
    return durable;
  } catch {
    return cached;
  }
}
