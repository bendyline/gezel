import type { AmbientDashboardResolution, AmbientDashboardStyle } from '@bendyline/gezel';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { runWithManagedBrowser } from '../rendering/managed-browser.js';

/**
 * Render an LLM-authored squisq dashboard document to a PNG via
 * squisq-cli's canonical dashboard renderer, on the service's managed
 * Chromium. The doc is pure markdown from the meester — no media — so
 * the content container is an empty read-only stub.
 */

export interface RenderAmbientDashboardOptions {
  home: string;
  markdown: string;
  outputPath: string;
  resolution: AmbientDashboardResolution;
  style: AmbientDashboardStyle;
  /** Title-band fallback when the doc's frontmatter has none. */
  documentTitle: string;
  signal?: AbortSignal;
}

export interface RenderAmbientDashboardResult {
  outputPath: string;
  width: number;
  height: number;
  /** Top-level block count of the parsed doc — the cell count. */
  blocks: number;
}

export type AmbientDashboardRenderer = (
  opts: RenderAmbientDashboardOptions,
) => Promise<RenderAmbientDashboardResult>;

export const renderAmbientDashboard: AmbientDashboardRenderer = async (opts) => {
  const parsed = parseMarkdown(opts.markdown);
  const doc = markdownToDoc(parsed);
  const blocks = doc.blocks.length;
  if (blocks === 0) {
    throw new Error('Dashboard document has no top-level blocks — nothing to render.');
  }

  const { renderDocToDashboardPng } = await import('@bendyline/squisq-cli/api');
  const result = await runWithManagedBrowser(opts.home, () =>
    renderDocToDashboardPng(doc, emptyContainer(opts.markdown), {
      outputPath: opts.outputPath,
      resolution: opts.resolution,
      // Options-level style + auto layout beat whatever frontmatter the
      // model produced, so a malformed key can't break the render.
      style: opts.style,
      layout: 'auto',
      documentTitle: opts.documentTitle,
      signal: opts.signal,
    }),
  );

  return {
    outputPath: result.outputPath ?? opts.outputPath,
    width: result.width,
    height: result.height,
    blocks,
  };
};

function emptyContainer(markdown: string): ContentContainer {
  const readOnly = async (): Promise<never> => {
    throw new Error('The ambient dashboard container is read-only.');
  };
  return {
    readFile: async () => null,
    writeFile: readOnly,
    removeFile: readOnly,
    listFiles: async () => [],
    exists: async () => false,
    getDocumentPath: async () => 'dashboard.md',
    readDocument: async () => markdown,
    writeDocument: readOnly,
  };
}
