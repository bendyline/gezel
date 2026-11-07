import { expect } from '@playwright/test';

/**
 * How far a measured layout may land from what a test expects. Fonts, subpixel
 * rounding and unrelated style changes move things by a pixel, and a test must
 * fail on a layout that is wrong, never on one that is 1px off. Every geometry
 * comparison, containment check and overflow check in the E2E suites uses it;
 * checks that run inside the page receive it as an `evaluate` argument.
 */
export const LAYOUT_TOLERANCE_PX = 2;

/** `actual` lands within the layout tolerance of `expected`. */
export function expectNear(actual: number, expected: number, message?: string): void {
  expect(
    Math.abs(actual - expected),
    message ?? `${actual} should be within ${LAYOUT_TOLERANCE_PX}px of ${expected}`,
  ).toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX);
}

/**
 * `actual` equals `expected` with every number allowed the layout tolerance.
 * Strings, such as fonts and colors, must still match exactly. A failure shows
 * the usual diff, limited to the values that are really out of place.
 */
export function expectLayoutToMatch<T>(
  actual: T,
  expected: T,
  message?: string,
  { soft = false }: { soft?: boolean } = {},
): void {
  (soft ? expect.soft : expect)(withinTolerance(actual, expected), message).toEqual(expected);
}

function withinTolerance(actual: unknown, expected: unknown): unknown {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) <= LAYOUT_TOLERANCE_PX ? expected : actual;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.map((value, index) => withinTolerance(value, expected[index]));
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    return Object.fromEntries(
      Object.entries(actual).map(([key, value]) => [
        key,
        withinTolerance(value, (expected as Record<string, unknown>)[key]),
      ]),
    );
  }
  return actual;
}
