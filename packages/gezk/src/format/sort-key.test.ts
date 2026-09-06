import { describe, expect, it } from 'vitest';
import { topicSortKeyForOrder } from './sort-key.js';

describe('topicSortKeyForOrder', () => {
  it('makes bytewise order agree with numeric order, negatives included', () => {
    const orders = [-2_147_483_648, -999_999, -26_234, -1, 0, 1, 2, 10, 999, 2_147_483_647];
    const keys = orders.map(topicSortKeyForOrder);
    const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sorted).toEqual(keys);
    for (const key of keys) expect(key).toMatch(/^[0-9]{10}$/);
  });

  it('is stable and documented by example', () => {
    expect(topicSortKeyForOrder(1)).toBe('2147483649');
    expect(topicSortKeyForOrder(-999_999)).toBe('2146483649');
    expect(topicSortKeyForOrder(0)).toBe('2147483648');
  });

  it('refuses anything that is not an int32', () => {
    for (const bad of [1.5, Number.NaN, 2_147_483_648, -2_147_483_649, Number.POSITIVE_INFINITY]) {
      expect(() => topicSortKeyForOrder(bad)).toThrow(RangeError);
    }
  });
});
