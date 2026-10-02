import { describe, expect, it } from 'vitest';
import { MAX_DIAGRAM_WIDTH_PT, pageSize, svgSize, withIntrinsicSize } from './diagram.js';

const MERMAID_ROOT =
  '<svg id="gezel-diagram-1" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 523.5px;" viewBox="-8 -8 523.5 278" role="graphics-document document"><g/></svg>';

describe('diagram sizing', () => {
  it('reads the natural size from the root viewBox', () => {
    expect(svgSize(MERMAID_ROOT)).toEqual({ width: 523.5, height: 278 });
    expect(() => svgSize('<svg width="100%"></svg>')).toThrow(/no size/);
  });

  it('pins the root to that size so it rasterizes at it', () => {
    const sized = withIntrinsicSize(MERMAID_ROOT, 523.5, 278);
    expect(sized).toMatch(/^<svg width="523.5" height="278" id="gezel-diagram-1"/);
    expect(sized).not.toContain('100%');
    expect(sized).not.toContain('max-width');
    expect(sized).toContain('<g/></svg>');
    expect(withIntrinsicSize('<svg viewBox="0 0 1 1"></svg>', 1, 1)).toContain(
      'xmlns="http://www.w3.org/2000/svg"',
    );
  });

  it('keeps a small diagram at its natural size and fits a wide one to the page', () => {
    expect(pageSize(200, 100)).toEqual({ widthPt: 150, heightPt: 75 });
    const wide = pageSize(1200, 300);
    expect(wide.widthPt).toBe(MAX_DIAGRAM_WIDTH_PT);
    expect(wide.heightPt).toBe(117);
  });
});
