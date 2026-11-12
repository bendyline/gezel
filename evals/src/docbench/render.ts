/**
 * Render a model's SVG to the PNG a vision judge looks at, the way a reader
 * would see it: dark ink on a light page, `currentColor` resolving to the
 * text color as it does in DocBlocks.
 *
 * The SVG is model output, so the page runs with JavaScript off and every
 * network request refused; the task pack has already held it to Squisq's
 * SVG-island sanitizer.
 */

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, chromium } from 'playwright';
import type { SvgRenderer } from './judge.ts';

const WIDTH = 800;

function page(svg: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;background:#ffffff;color:#1f2328;font-family:system-ui,sans-serif}',
    `svg{display:block;width:${String(WIDTH)}px;height:auto;max-height:1600px}`,
    '</style></head><body>',
    svg,
    '</body></html>',
  ].join('');
}

export interface SvgRenderSession {
  readonly render: SvgRenderer;
  close(): Promise<void>;
}

/** One browser for a whole judging pass; PNGs are cached by content in `dir`. */
export async function openSvgRenderer(dir: string): Promise<SvgRenderSession> {
  await mkdir(dir, { recursive: true });
  // The launch itself is shared: judge calls run concurrently, and each
  // awaiting its own launch left every browser but the last one running.
  let launching: Promise<Browser> | null = null;
  const render: SvgRenderer = async (svg) => {
    const file = join(dir, `${createHash('sha256').update(svg).digest('hex').slice(0, 16)}.png`);
    launching ??= chromium.launch({ headless: true });
    const browser = await launching;
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: WIDTH + 40, height: 1700 },
      deviceScaleFactor: 1,
    });
    try {
      await context.route('**/*', (route) => route.abort());
      const tab = await context.newPage();
      await tab.setContent(page(svg), { waitUntil: 'load' });
      await tab.locator('svg').first().screenshot({ path: file });
      return file;
    } finally {
      await context.close();
    }
  };
  return {
    render,
    async close() {
      const pending = launching;
      launching = null;
      if (pending) await (await pending).close();
    },
  };
}
