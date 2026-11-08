// The startup screen draws its own copy of the intro sheet before React
// loads, and its rail has to pull exactly like the live one it hands over to.

/** Movement under this is a press on the rail, not a drag. */
export const RAIL_DRAG_SLOP_PX = 4;
/** Let go after lifting the rail this share of the sheet, and it rolls up. */
const RAIL_ROLL_UP_SHARE = 0.25;
const RAIL_ROLL_UP_MIN_PX = 48;

/** The sheet's height while its rail is lifted `lift` px above where it was taken. */
export function railDragHeight(height: number, lift: number): number {
  return height - Math.min(Math.max(lift, 0), height);
}

/** Whether letting go after lifting the rail `lift` px rolls the sheet up. */
export function railRollsUp(height: number, lift: number): boolean {
  return lift >= Math.max(RAIL_ROLL_UP_MIN_PX, height * RAIL_ROLL_UP_SHARE);
}
