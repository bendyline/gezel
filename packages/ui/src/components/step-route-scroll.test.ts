import { describe, expect, it } from 'vitest';
import { snapRouteScroll } from './step-route-scroll.js';

// Six 184px columns after the route's 12px padding.
const columns = Array.from({ length: 6 }, (_, i) => ({ left: 12 + i * 184, right: 196 + i * 184 }));

describe('snapRouteScroll', () => {
  // Centering step 4 put the edge 30px into step 3, and its caption read
  // "rite the Markdown docu…" (2026-11-09).
  it('shows the whole column when the edge falls early in it', () => {
    expect(snapRouteScroll(380 + 30, columns)).toBe(380);
  });

  it('moves past the column when the edge falls late in it', () => {
    expect(snapRouteScroll(380 + 150, columns)).toBe(564);
  });

  it('keeps the route’s own padding when it lands in the first column', () => {
    expect(snapRouteScroll(40, columns)).toBe(0);
  });

  it('leaves a position on a boundary, before the route, or past it alone', () => {
    expect(snapRouteScroll(380, columns)).toBe(380);
    expect(snapRouteScroll(-50, columns)).toBe(0);
    expect(snapRouteScroll(5000, columns)).toBe(5000);
  });
});
