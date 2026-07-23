import type { PixelsLayer } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { defaultPixelScale, pixelArtToHtml } from './pixel-art.js';

function layer(rows: string[], palette: Record<string, string>): PixelsLayer {
  return { kind: 'pixels', rows, palette };
}

describe('pixelArtToHtml', () => {
  it('builds a grid with one cell per character', () => {
    const html = pixelArtToHtml(layer(['rw', 'wr'], { r: '#ff0000ff', w: '#ffffffff' }), 4);
    expect(html).toMatch(/grid-template-columns:repeat\(2,4px\)/);
    expect(html).toMatch(/grid-template-rows:repeat\(2,4px\)/);
    // 4 cells, each an <i> tag.
    expect(html.match(/<i /g)?.length).toBe(4);
    // First cell is red, last cell is red, middle two are white.
    expect(html).toContain('rgba(255, 0, 0, 1)');
    expect(html).toContain('rgba(255, 255, 255, 1)');
  });

  it('includes image-rendering:pixelated', () => {
    const html = pixelArtToHtml(layer(['r'], { r: '#ff0000ff' }), 8);
    expect(html).toContain('image-rendering:pixelated');
  });

  it('handles the user-doc example verbatim', () => {
    const html = pixelArtToHtml(
      layer(['wrw', 'rrr', 'wrw'], { w: '#ffffffff', r: '#ff0000ff' }),
      2,
    );
    expect(html).toMatch(/grid-template-columns:repeat\(3,2px\)/);
    expect(html.match(/<i /g)?.length).toBe(9);
  });

  it('rejects uneven rows', () => {
    expect(() => pixelArtToHtml(layer(['rr', 'r'], { r: '#f00' }), 4)).toThrow(
      /rows must be the same length/,
    );
  });

  it('rejects missing palette entries', () => {
    expect(() => pixelArtToHtml(layer(['rx'], { r: '#f00' }), 4)).toThrow(/"x" not in palette/);
  });

  it('rejects empty rows', () => {
    expect(() => pixelArtToHtml(layer([], { r: '#f00' }), 4)).toThrow();
    expect(() => pixelArtToHtml(layer([''], { r: '#f00' }), 4)).toThrow();
  });
});

describe('defaultPixelScale', () => {
  it('fits the layer into the provided canvas', () => {
    const l = layer(['wrw', 'rrr', 'wrw'], { w: '#fff', r: '#f00' });
    // 3×3 grid fitting a 30px-wide layer → 10px cells.
    expect(defaultPixelScale({ ...l, width: 30, height: 30 }, 100, 100)).toBe(10);
  });

  it('falls back to the canvas when no layer dimensions are set', () => {
    const l = layer(['rr'], { r: '#f00' });
    // 1 row × 2 cols, 64×64 canvas → scale = floor(min(32, 64)) = 32.
    expect(defaultPixelScale(l, 64, 64)).toBe(32);
  });

  it('never returns less than 1', () => {
    const l = layer(['rrrrrrrrrrrrrrrrrr'], { r: '#f00' });
    expect(defaultPixelScale({ ...l, width: 1, height: 1 }, 1, 1)).toBe(1);
  });
});
