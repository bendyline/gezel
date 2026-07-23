import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Layer, type RenderImageRequest, createLogger } from '@bendyline/gezel';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import type { Browser, BrowserContext } from 'playwright-core';
import { sanitizeSvg } from '../icon/sanitize.js';
import { parseColor, toCssRgba } from './color.js';
import { defaultPixelScale, pixelArtToHtml } from './pixel-art.js';

const log = createLogger('rendering');

export interface RenderResult {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: string;
  engine: 'playwright' | 'resvg';
}

export interface RenderOptions {
  /**
   * Resolve an `image` layer's `artifactPath` to a `data:` URL. Called
   * once per image layer before the composition HTML is built — returns
   * null when the artifact is missing, which renders the layer as a
   * transparent rectangle.
   */
  resolveImage?(artifactPath: string): Promise<string | null>;
}

/**
 * Long-lived renderer: owns one Chromium instance across the lifetime of
 * the service, plus an on-demand resvg binding for the pure-SVG fast
 * path. Renders are isolated by spawning a fresh BrowserContext per
 * call.
 *
 * If Chromium hasn't finished downloading yet (the system-toolset
 * bootstrap runs in the background at boot) the first `render()` call
 * throws; callers should surface the "not ready" case to the agent.
 */
export class ImageRenderer {
  private readonly home: string;
  private browser: Browser | null = null;
  private launchInFlight: Promise<Browser> | null = null;
  private resvgCtor: typeof import('@resvg/resvg-js').Resvg | null | undefined;

  constructor(args: { home: string }) {
    this.home = args.home;
  }

  async render(req: RenderImageRequest, opts: RenderOptions = {}): Promise<RenderResult> {
    const format = req.format ?? 'png';
    if (this.shouldUseResvgFastPath(req)) {
      try {
        return await this.renderSvgWithResvg(req);
      } catch (err) {
        log.warn(
          `[renderer] resvg fast-path failed (${(err as Error).message}); falling back to Playwright.`,
        );
      }
    }
    return this.renderWithPlaywright(req, format, opts);
  }

  async stop(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.launchInFlight = null;
    if (b) {
      try {
        await b.close();
      } catch {
        /* ignore */
      }
    }
  }

  private shouldUseResvgFastPath(req: RenderImageRequest): boolean {
    if (req.layers.length !== 1) return false;
    const layer = req.layers[0]!;
    if (layer.kind !== 'svg') return false;
    if (layer.rotate) return false;
    if (layer.opacity !== undefined && layer.opacity < 1) return false;
    const offsetX = layer.x ?? 0;
    const offsetY = layer.y ?? 0;
    if (offsetX !== 0 || offsetY !== 0) return false;
    const w = layer.width ?? req.width;
    const h = layer.height ?? req.height;
    if (w !== req.width || h !== req.height) return false;
    if (req.format === 'jpeg') return false;
    return true;
  }

  private async renderSvgWithResvg(req: RenderImageRequest): Promise<RenderResult> {
    const Resvg = await this.loadResvg();
    if (!Resvg) throw new Error('resvg not available');
    const layer = req.layers[0];
    if (!layer || layer.kind !== 'svg') throw new Error('unreachable');
    const svg = sanitizeSvg(layer.svg) || layer.svg;
    const background = req.background ? toCssRgba(parseColor(req.background)) : undefined;
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: req.width },
      ...(background ? { background } : {}),
    });
    const png = resvg.render();
    const buffer = Buffer.from(png.asPng());
    return {
      buffer,
      width: req.width,
      height: req.height,
      mimeType: 'image/png',
      engine: 'resvg',
    };
  }

  private async loadResvg(): Promise<typeof import('@resvg/resvg-js').Resvg | null> {
    if (this.resvgCtor !== undefined) return this.resvgCtor;
    try {
      const mod = await import('@resvg/resvg-js');
      this.resvgCtor = mod.Resvg;
    } catch (err) {
      log.warn(`[renderer] @resvg/resvg-js unavailable: ${(err as Error).message}`);
      this.resvgCtor = null;
    }
    return this.resvgCtor;
  }

  private async renderWithPlaywright(
    req: RenderImageRequest,
    format: 'png' | 'jpeg',
    opts: RenderOptions,
  ): Promise<RenderResult> {
    const browser = await this.ensureBrowser();
    const context: BrowserContext = await browser.newContext({
      viewport: { width: req.width, height: req.height },
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
    });
    try {
      // Block every request that isn't our synthetic data: URL. Keeps
      // untrusted HTML/SVG from phoning home.
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('data:')) return route.continue();
        return route.abort();
      });

      const imageDataUrls = await resolveImageLayers(req, opts.resolveImage);
      const html = buildCompositionHtml(req, imageDataUrls);
      const page = await context.newPage();
      await page.setViewportSize({ width: req.width, height: req.height });
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
        waitUntil: 'load',
      });

      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const shot = await page.screenshot({
        type: format,
        omitBackground: !req.background,
        clip: { x: 0, y: 0, width: req.width, height: req.height },
        ...(format === 'jpeg' ? { quality: 92 } : {}),
      });
      return {
        buffer: Buffer.from(shot),
        width: req.width,
        height: req.height,
        mimeType,
        engine: 'playwright',
      };
    } finally {
      await context.close().catch(() => {
        /* ignore */
      });
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.launchInFlight) return this.launchInFlight;
    this.launchInFlight = this.launchBrowser();
    try {
      this.browser = await this.launchInFlight;
      return this.browser;
    } finally {
      this.launchInFlight = null;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const browsersDir = playwrightBrowsersDir(this.home);
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= browsersDir;
    const executablePath = await resolveChromiumBinary(browsersDir);
    if (!executablePath) {
      throw new Error(
        `[renderer] Chromium not found under ${browsersDir}. The system-toolset bootstrap downloads it on first boot — wait for the Home screen's Playwright pill to turn green and retry.`,
      );
    }
    const { chromium } = await import('playwright-core');
    return chromium.launch({
      headless: true,
      executablePath,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
  }
}

/**
 * Flatten layers into a single data:URL HTML document. Each layer is
 * positioned absolutely inside a canvas-sized stage. Image layers
 * reference data URLs populated by the caller (we pre-encoded them in
 * the route handler because Playwright's route blocking cuts off
 * cross-origin fetch).
 */
async function resolveImageLayers(
  req: RenderImageRequest,
  resolve: ((path: string) => Promise<string | null>) | undefined,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!resolve) return out;
  for (let i = 0; i < req.layers.length; i += 1) {
    const layer = req.layers[i]!;
    if (layer.kind !== 'image') continue;
    const url = await resolve(layer.artifactPath);
    if (url) out.set(i, url);
  }
  return out;
}

function buildCompositionHtml(req: RenderImageRequest, imageDataUrls: Map<number, string>): string {
  const pieces: string[] = [];
  for (let i = 0; i < req.layers.length; i += 1) {
    const layer = req.layers[i]!;
    pieces.push(renderLayer(layer, req.width, req.height, imageDataUrls.get(i)));
  }
  const bg = req.background ? toCssRgba(parseColor(req.background)) : 'transparent';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: ${req.width}px;
    height: ${req.height}px;
    overflow: hidden;
    background: ${bg};
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .stage {
    position: relative;
    width: ${req.width}px;
    height: ${req.height}px;
  }
  .layer {
    position: absolute;
    top: 0;
    left: 0;
  }
</style>
</head>
<body>
<div class="stage">
${pieces.join('\n')}
</div>
</body>
</html>`;
}

function renderLayer(
  layer: Layer,
  canvasW: number,
  canvasH: number,
  imageDataUrl: string | undefined,
): string {
  const style = layerWrapperStyle(layer, canvasW, canvasH);
  switch (layer.kind) {
    case 'svg': {
      const svg = sanitizeSvg(layer.svg) || '';
      const transform = layer.rotate
        ? `transform: rotate(${layer.rotate}deg); transform-origin: center center;`
        : '';
      return `<div class="layer" style="${style}${transform}">${svg}</div>`;
    }
    case 'html': {
      const attrs = 'sandbox="" style="border:0;width:100%;height:100%;"';
      const srcdoc = escapeAttr(layer.html);
      return `<div class="layer" style="${style}"><iframe srcdoc="${srcdoc}" ${attrs}></iframe></div>`;
    }
    case 'pixels': {
      const scale = layer.scale ?? defaultPixelScale(layer, canvasW, canvasH);
      const fragment = pixelArtToHtml(layer, scale);
      return `<div class="layer" style="${style}">${fragment}</div>`;
    }
    case 'image': {
      const src = imageDataUrl ?? '';
      return `<div class="layer" style="${style}"><img src="${escapeAttr(
        src,
      )}" style="width:100%;height:100%;image-rendering:pixelated;" /></div>`;
    }
    case 'text': {
      const color = layer.color ? toCssRgba(parseColor(layer.color)) : '#000';
      const fontSize = layer.size ?? 16;
      const weight = layer.weight ?? 400;
      const family = layer.font ?? 'system-ui, -apple-system, sans-serif';
      const opacity = layer.opacity ?? 1;
      return `<div class="layer" style="left:${layer.x}px;top:${layer.y}px;color:${color};font-size:${fontSize}px;font-weight:${weight};font-family:${escapeAttr(family)};opacity:${opacity};white-space:pre;">${escapeHtml(
        layer.text,
      )}</div>`;
    }
  }
}

function layerWrapperStyle(layer: Layer, canvasW: number, canvasH: number): string {
  if (layer.kind === 'text') return '';
  const x = (layer as { x?: number }).x ?? 0;
  const y = (layer as { y?: number }).y ?? 0;
  const w = (layer as { width?: number }).width ?? canvasW;
  const h = (layer as { height?: number }).height ?? canvasH;
  const opacity = (layer as { opacity?: number }).opacity ?? 1;
  return `left:${x}px;top:${y}px;width:${w}px;height:${h}px;opacity:${opacity};`;
}

function escapeAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Find the Chromium binary installed by the system-toolset bootstrap.
 * We take whichever `chromium-*` dir carries Playwright's own
 * `INSTALLATION_COMPLETE` marker — that's the exact revision the
 * `@playwright/mcp` toolset pulled down, so there's no version-drift
 * risk between our `playwright-core` node module and the on-disk
 * browser. Returns `null` when the bootstrap hasn't finished yet or the
 * dir is missing; callers surface that as "not ready" rather than
 * silently triggering a second download.
 */
async function resolveChromiumBinary(browsersDir: string): Promise<string | null> {
  if (!existsSync(browsersDir)) return null;
  let entries: string[];
  try {
    entries = await readdir(browsersDir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const name of candidates) {
    const root = join(browsersDir, name);
    if (!existsSync(join(root, 'INSTALLATION_COMPLETE'))) continue;
    const bin = chromiumBinaryPath(root);
    if (bin && existsSync(bin)) return bin;
  }
  return null;
}

function chromiumBinaryPath(chromiumDir: string): string | null {
  switch (process.platform) {
    case 'darwin':
      return join(chromiumDir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    case 'win32':
      return join(chromiumDir, 'chrome-win', 'chrome.exe');
    case 'linux':
      return join(chromiumDir, 'chrome-linux', 'chrome');
    default:
      return null;
  }
}
