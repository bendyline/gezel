import { describe, expect, it } from 'vitest';
import { LEGACY_URBANITY, bandOf, byUrbanity, urbanityOf } from './urbanity.js';

describe('bandOf', () => {
  it('maps the server buckets to the three architectural registers', () => {
    expect(bandOf({ settlement: 'hamlet' })).toBe('village');
    expect(bandOf({ settlement: 'village' })).toBe('village');
    expect(bandOf({ settlement: 'town' })).toBe('town');
    expect(bandOf({ settlement: 'city' })).toBe('city');
  });

  it('puts a payload with no settlement in the town band', () => {
    // Every map built before the field existed must draw exactly as it did.
    expect(bandOf({})).toBe('town');
    expect(bandOf({ settlement: undefined })).toBe('town');
  });
});

describe('urbanityOf', () => {
  it('passes the server value through', () => {
    expect(urbanityOf({ urbanity: 0 })).toBe(0);
    expect(urbanityOf({ urbanity: 0.83 })).toBe(0.83);
    expect(urbanityOf({ urbanity: 1 })).toBe(1);
  });

  it('falls back mid-range for legacy payloads', () => {
    expect(urbanityOf({})).toBe(LEGACY_URBANITY);
    // The fallback must agree with bandOf's legacy answer, or a legacy map
    // would get city materials on town buildings.
    expect(LEGACY_URBANITY).toBeGreaterThan(0.3);
    expect(LEGACY_URBANITY).toBeLessThan(0.74);
  });
});

describe('byUrbanity', () => {
  it('lerps between the rural and urban ends', () => {
    expect(byUrbanity({ urbanity: 0 }, 2, 10)).toBe(2);
    expect(byUrbanity({ urbanity: 1 }, 2, 10)).toBe(10);
    expect(byUrbanity({ urbanity: 0.5 }, 2, 10)).toBe(6);
  });

  it('clamps out-of-range input rather than extrapolating', () => {
    expect(byUrbanity({ urbanity: -1 }, 2, 10)).toBe(2);
    expect(byUrbanity({ urbanity: 4 }, 2, 10)).toBe(10);
  });

  it('handles an inverted range (urban end lower than rural)', () => {
    expect(byUrbanity({ urbanity: 1 }, 10, 2)).toBe(2);
  });
});
