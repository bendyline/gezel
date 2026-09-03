import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from './jcs.js';

describe('RFC 8785 canonical JSON', () => {
  it('sorts keys by UTF-16 code units and drops undefined members', () => {
    expect(canonicalizeJson({ b: 1, a: [true, null, 'x'], ä: 2, skip: undefined })).toBe(
      '{"a":[true,null,"x"],"b":1,"ä":2}',
    );
  });

  it('serializes numbers the ECMAScript way', () => {
    expect(canonicalizeJson({ n: 1e21, m: 0.000001, k: 10 })).toBe(
      '{"k":10,"m":0.000001,"n":1e+21}',
    );
  });

  it('rejects values without a JSON identity', () => {
    expect(() => canonicalizeJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalizeJson({ f: () => 1 })).toThrow(/no JSON identity/);
  });
});
