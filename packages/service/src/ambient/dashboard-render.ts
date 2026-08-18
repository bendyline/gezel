import { writeFile } from 'node:fs/promises';
import type {
  AmbientDashboardDisplayTarget,
  AmbientDashboardResolution,
  AmbientDashboardStyle,
  AmbientDashboardTheme,
} from '@bendyline/gezel';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { resolveTheme } from '@bendyline/squisq/schemas';
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
  /** User-selected Squisq theme; overrides any model-authored frontmatter. */
  themeId: AmbientDashboardTheme;
  /** Full primary-display canvas plus its OS-chrome-safe content rectangle. */
  displayTarget?: AmbientDashboardDisplayTarget;
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

  const displayTarget = opts.displayTarget;
  const theme = resolveTheme(opts.themeId);
  const themedDoc = { ...doc, themeId: theme.id };
  const { renderDocToDashboardPng } = await import('@bendyline/squisq-cli/api');
  const result = await runWithManagedBrowser(opts.home, () =>
    renderDocToDashboardPng(themedDoc, emptyContainer(opts.markdown), {
      // A reported display target renders the dashboard at the safe content
      // rectangle's exact size first. We pad it to the full monitor canvas
      // below, preserving both the monitor aspect ratio and OS safe areas.
      ...(displayTarget
        ? {
            width: displayTarget.safeArea.width,
            height: displayTarget.safeArea.height,
          }
        : { resolution: opts.resolution, outputPath: opts.outputPath }),
      // Options-level style + auto layout beat whatever frontmatter the
      // model produced, so a malformed key can't break the render.
      style: opts.style,
      layout: 'auto',
      documentTitle: opts.documentTitle,
      signal: opts.signal,
    }),
  );

  if (displayTarget) {
    const bytes = await placeDashboardInSafeArea(
      result.bytes,
      displayTarget,
      theme.colors.background,
    );
    await writeFile(opts.outputPath, bytes);
  }

  return {
    outputPath: opts.outputPath,
    width: displayTarget?.width ?? result.width,
    height: displayTarget?.height ?? result.height,
    blocks,
  };
};

/**
 * Compose a safe-area-sized dashboard onto a full-display PNG. The outer
 * canvas deliberately stays opaque: wallpaper engines disagree on how to
 * blend transparent pixels. The padding uses the selected theme background,
 * so a dark dashboard never gains a white frame. Resvg is already the
 * service's native SVG raster fast path, so this adds no second browser launch
 * or image-library dependency.
 */
export async function placeDashboardInSafeArea(
  dashboardPng: Uint8Array,
  target: AmbientDashboardDisplayTarget,
  backgroundColor = '#ffffff',
): Promise<Uint8Array> {
  const { x, y, width, height } = target.safeArea;
  const encoded = Buffer.from(dashboardPng).toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${target.width}" height="${target.height}" viewBox="0 0 ${target.width} ${target.height}">
<rect width="100%" height="100%" fill="${escapeXmlAttribute(backgroundColor)}"/>
<image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" href="data:image/png;base64,${encoded}"/>
</svg>`;
  const { Resvg } = await import('@resvg/resvg-js');
  return new Resvg(svg).render().asPng();
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

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
