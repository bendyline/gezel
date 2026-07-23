import { describe, expect, it } from 'vitest';
import { guardZipArchive } from './archive-guard.js';

// Build just enough of a ZIP for the guard, which reads only the central
// directory + EOCD (never local headers or compressed data). We lay the
// central directory at offset 0 followed by the EOCD.
function cdfh(name: string, compressed: number, uncompressed: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const buf = Buffer.alloc(46 + nameBuf.length);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt32LE(compressed >>> 0, 20);
  buf.writeUInt32LE(uncompressed >>> 0, 24);
  buf.writeUInt16LE(nameBuf.length, 28);
  nameBuf.copy(buf, 46);
  return buf;
}

function eocd(count: number, cdSize: number, cdOffset: number): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(count, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(cdSize, 12);
  buf.writeUInt32LE(cdOffset, 16);
  return buf;
}

function buildZip(
  entries: { name: string; compressed: number; uncompressed: number }[],
): Uint8Array {
  const cd = Buffer.concat(entries.map((e) => cdfh(e.name, e.compressed, e.uncompressed)));
  return Buffer.concat([cd, eocd(entries.length, cd.length, 0)]);
}

describe('guardZipArchive', () => {
  it('accepts a normal small archive', () => {
    const zip = buildZip([
      { name: 'word/document.xml', compressed: 400, uncompressed: 1200 },
      { name: '[Content_Types].xml', compressed: 200, uncompressed: 600 },
    ]);
    const r = guardZipArchive(zip);
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(2);
  });

  it('rejects an archive with too many entries', () => {
    const entries = Array.from({ length: 4097 }, (_, i) => ({
      name: `e${i}`,
      compressed: 1,
      uncompressed: 1,
    }));
    const r = guardZipArchive(buildZip(entries));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/entries/);
  });

  it('rejects a single entry that expands beyond the per-entry cap', () => {
    const r = guardZipArchive(
      buildZip([{ name: 'bomb', compressed: 100, uncompressed: 200 * 1024 * 1024 }]),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expands/);
  });

  it('rejects a high compression ratio (classic bomb)', () => {
    const r = guardZipArchive(
      buildZip([{ name: 'bomb', compressed: 2000, uncompressed: 2000 * 500 }]),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ratio/);
  });

  it('rejects bytes with no EOCD record', () => {
    const r = guardZipArchive(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/end-of-central-directory/);
  });
});
