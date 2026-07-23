/**
 * Export option types + localStorage persistence for the "quick-export"
 * shortcut. Ported from docblocks's matching module so the affordance
 * — first export uses the dialog, subsequent exports skip straight to
 * the previous format — lands identically here.
 */

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

export function loadLastExportOptions(): ExportOptions | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ExportOptions>;
    return { ...DEFAULT_OPTIONS, ...parsed };
  } catch {
    return null;
  }
}

export function saveExportOptions(options: ExportOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // ignore quota / privacy-mode failures
  }
}
