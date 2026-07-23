import type { PixelsLayer } from '@bendyline/gezel';
import { parseColor, toCssRgba } from './color.js';

/**
 * Convert a pixel-art layer into an HTML fragment: a `<div>` grid with
 * one solid cell per character. The container applies
 * `image-rendering: pixelated` so any downstream scaling stays crisp.
 *
 * Throws if `rows` are uneven or reference a character missing from
 * `palette`.
 */
export function pixelArtToHtml(layer: PixelsLayer, scale: number): string {
  const rows = layer.rows;
  if (rows.length === 0) throw new Error('pixels layer: rows must not be empty');
  const cols = rows[0]!.length;
  if (cols === 0) throw new Error('pixels layer: rows must not be empty strings');
  for (const r of rows) {
    if (r.length !== cols) {
      throw new Error(
        `pixels layer: rows must be the same length (expected ${cols}, got ${r.length})`,
      );
    }
  }

  const colorCache = new Map<string, string>();
  const colorFor = (ch: string): string => {
    const cached = colorCache.get(ch);
    if (cached) return cached;
    const raw = layer.palette[ch];
    if (!raw) throw new Error(`pixels layer: character "${ch}" not in palette`);
    const css = toCssRgba(parseColor(raw));
    colorCache.set(ch, css);
    return css;
  };

  const width = cols * scale;
  const height = rows.length * scale;
  const cellStyle = `width:${scale}px;height:${scale}px;`;

  let cells = '';
  for (const row of rows) {
    for (const ch of row) {
      cells += `<i style="${cellStyle}background:${colorFor(ch)};"></i>`;
    }
  }

  return `<div class="pixels" style="display:grid;grid-template-columns:repeat(${cols},${scale}px);grid-template-rows:repeat(${rows.length},${scale}px);width:${width}px;height:${height}px;image-rendering:pixelated;line-height:0;font-size:0;">${cells}</div>`;
}

/**
 * Pick a default scale so a pixel grid fills a reasonable portion of the
 * canvas when the layer doesn't specify one. Round down so the grid
 * never exceeds the layer's allotted width/height.
 */
export function defaultPixelScale(
  layer: PixelsLayer,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const rows = layer.rows.length;
  const cols = layer.rows[0]?.length ?? 1;
  const targetW = layer.width ?? canvasWidth;
  const targetH = layer.height ?? canvasHeight;
  const scale = Math.max(1, Math.floor(Math.min(targetW / cols, targetH / rows)));
  return scale;
}
