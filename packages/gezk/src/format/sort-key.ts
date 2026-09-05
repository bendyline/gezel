/**
 * Topic ordering keys. `topics.sort_key` is a TEXT column compared bytewise
 * by every reader (`ORDER BY sort_key, id`), so a producer that orders topics
 * numerically must encode the number so that byte order equals numeric
 * order. Offsetting by 2^31 makes every int32 non-negative and ten digits
 * wide; zero-padding then makes the string comparison agree with the
 * integer comparison, negatives included.
 */

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const OFFSET = 2_147_483_648;

export function topicSortKeyForOrder(order: number): string {
  if (!Number.isInteger(order) || order < INT32_MIN || order > INT32_MAX) {
    throw new RangeError(`topic order must be an int32: ${String(order)}`);
  }
  return String(order + OFFSET).padStart(10, '0');
}
