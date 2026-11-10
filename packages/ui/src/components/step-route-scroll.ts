/** A route column's horizontal extent, in the viewport's scroll coordinates. */
export interface RouteColumn {
  left: number;
  right: number;
}

/**
 * Where to scroll a route so the selected step sits near the middle without
 * the viewport's left edge cutting through a column. Centering alone landed
 * mid-column, so the first visible caption read "rite the Markdown docu…" for
 * "Write the Markdown document" (2026-11-09): clipped at its start by the
 * edge, then ellipsized at its end. A caption may still be cut at the right
 * edge, where it reads as truncated at its end.
 *
 * The edge moves to the nearer side of the column it falls in: back to show
 * the whole column, or on past it. The first column snaps to 0, so the route's
 * own padding stays on screen.
 */
export function snapRouteScroll(desired: number, columns: readonly RouteColumn[]): number {
  const left = Math.max(0, desired);
  const index = columns.findIndex((column) => column.left < left && left < column.right);
  if (index === -1) return left;
  const column = columns[index]!;
  if (left - column.left <= column.right - left) return index === 0 ? 0 : column.left;
  return column.right;
}
