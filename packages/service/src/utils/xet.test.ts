import { describe, expect, it } from 'vitest';
import {
  XET_CHUNK_HEADER_BYTES,
  bg4Unregroup,
  decodeChunk,
  decodeSegmentChunks,
  lz4DecompressFrame,
  parseLinkHeader,
} from './xet.js';

// Build a minimal LZ4 frame: magic + FLG(version=1, no flags) + BD + HC=0,
// then the given blocks, then the end mark. `blocks` are {compressed, bytes}.
function lz4Frame(blocks: Array<{ compressed: boolean; bytes: number[] }>): Buffer {
  const parts: number[] = [
    0x04,
    0x22,
    0x4d,
    0x18, // magic 0x184D2204 LE
    0x40, // FLG: version=01, everything else off
    0x70, // BD: block-max-size (unused by our decoder)
    0x00, // HC (header checksum — decoder skips, doesn't validate)
  ];
  for (const b of blocks) {
    const size = b.bytes.length | (b.compressed ? 0 : 0x80000000);
    parts.push(size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff);
    parts.push(...b.bytes);
  }
  parts.push(0, 0, 0, 0); // end mark
  return Buffer.from(parts);
}

// bg4 forward transform (test-only), the inverse of bg4Unregroup.
function bg4Regroup(orig: Buffer): Buffer {
  const len = orig.length;
  const s0 = Math.floor((len + 3) / 4);
  const s1 = Math.floor((len + 2) / 4);
  const s2 = Math.floor((len + 1) / 4);
  let c0 = 0;
  let c1 = s0;
  let c2 = s0 + s1;
  let c3 = s0 + s1 + s2;
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    const plane = i & 3;
    const dst = plane === 0 ? c0++ : plane === 1 ? c1++ : plane === 2 ? c2++ : c3++;
    out[dst] = orig[i]!;
  }
  return out;
}

// A chunk = 8-byte header + payload. Header: ver=0, compLen(u24 LE), scheme, uncompLen(u24 LE).
function chunk(scheme: number, payload: number[], uncompLen: number): number[] {
  const c = payload.length;
  return [
    0,
    c & 0xff,
    (c >> 8) & 0xff,
    (c >> 16) & 0xff,
    scheme,
    uncompLen & 0xff,
    (uncompLen >> 8) & 0xff,
    (uncompLen >> 16) & 0xff,
    ...payload,
  ];
}

describe('lz4DecompressFrame', () => {
  it('decodes an uncompressed (stored) block', () => {
    const raw = [...Buffer.from('hello xet')];
    const frame = lz4Frame([{ compressed: false, bytes: raw }]);
    expect(lz4DecompressFrame(frame, raw.length)).toEqual(Buffer.from('hello xet'));
  });

  it('decodes a compressed block with literals + a back-reference match', () => {
    // Sequence: token 0x40 (litLen=4, matchLen nibble=0 → match 4), literals
    // "abcd", offset 4 → copies "abcd" again. Output = "abcdabcd".
    const block = [0x40, 0x61, 0x62, 0x63, 0x64, 0x04, 0x00];
    const frame = lz4Frame([{ compressed: true, bytes: block }]);
    expect(lz4DecompressFrame(frame, 8)).toEqual(Buffer.from('abcdabcd'));
  });

  it('throws on a non-frame payload', () => {
    expect(() => lz4DecompressFrame(Buffer.from([1, 2, 3, 4, 5, 6, 7]), 3)).toThrow(
      /not an LZ4 frame/,
    );
  });

  it('throws when output size disagrees with the header', () => {
    const raw = [...Buffer.from('hello')];
    const frame = lz4Frame([{ compressed: false, bytes: raw }]);
    expect(() => lz4DecompressFrame(frame, 4)).toThrow(/produced 5 bytes, expected 4/);
  });
});

describe('bg4Unregroup', () => {
  it('inverts regrouping for every length remainder mod 4', () => {
    for (const len of [16, 17, 18, 19, 20, 1, 2, 3]) {
      const orig = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff));
      expect(bg4Unregroup(bg4Regroup(orig), len)).toEqual(orig);
    }
  });
});

describe('decodeChunk', () => {
  it('decodes an uncompressed (scheme 0 / None) chunk', () => {
    const payload = [...Buffer.from('hi')];
    const buf = Buffer.from(chunk(0, payload, payload.length));
    const { data, next } = decodeChunk(buf, 0);
    expect(data).toEqual(Buffer.from('hi'));
    expect(next).toBe(XET_CHUNK_HEADER_BYTES + payload.length);
  });

  it('decodes an LZ4 (scheme 1) chunk wrapping a frame', () => {
    const frame = [...lz4Frame([{ compressed: false, bytes: [...Buffer.from('payload')] }])];
    const buf = Buffer.from(chunk(1, frame, 7));
    expect(decodeChunk(buf, 0).data).toEqual(Buffer.from('payload'));
  });

  it('decodes a bg4 (scheme 2) chunk (regroup → LZ4 frame → unregroup)', () => {
    const orig = Buffer.from(Array.from({ length: 21 }, (_, i) => (i * 13) & 0xff));
    const regrouped = [...bg4Regroup(orig)];
    const frame = [...lz4Frame([{ compressed: false, bytes: regrouped }])];
    const buf = Buffer.from(chunk(2, frame, orig.length));
    expect(decodeChunk(buf, 0).data).toEqual(orig);
  });

  it('rejects an unknown compression scheme', () => {
    const buf = Buffer.from(chunk(9, [1, 2, 3], 3));
    expect(() => decodeChunk(buf, 0)).toThrow(/unknown compression scheme 9/);
  });
});

describe('decodeSegmentChunks', () => {
  it('walks consecutive chunks and stops at the expected count', () => {
    const c1 = chunk(0, [...Buffer.from('foo')], 3);
    const c2 = chunk(0, [...Buffer.from('barbar')], 6);
    const seg = Buffer.from([...c1, ...c2]);
    expect(decodeSegmentChunks(seg, 2)).toEqual([Buffer.from('foo'), Buffer.from('barbar')]);
  });

  it('throws if the segment has fewer chunks than expected', () => {
    const seg = Buffer.from(chunk(0, [...Buffer.from('foo')], 3));
    expect(() => decodeSegmentChunks(seg, 2)).toThrow(/decoded 1 chunks, expected 2/);
  });
});

describe('parseLinkHeader', () => {
  it('parses rel → url pairs', () => {
    const h =
      '<https://huggingface.co/api/models/org/repo/xet-read-token/abc>; rel="xet-auth", ' +
      '<https://cas-server.xethub.hf.co/v1/reconstructions/deadbeef>; rel="xet-reconstruction-info"';
    expect(parseLinkHeader(h)).toEqual({
      'xet-auth': 'https://huggingface.co/api/models/org/repo/xet-read-token/abc',
      'xet-reconstruction-info': 'https://cas-server.xethub.hf.co/v1/reconstructions/deadbeef',
    });
  });

  it('returns {} for a null header', () => {
    expect(parseLinkHeader(null)).toEqual({});
  });
});
