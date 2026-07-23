import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertInSandbox } from './sandbox-convert.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-sbxconv-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Minimal ZIP whose central directory declares a bomb-sized entry. */
function bombZip(uncompressed: number): Buffer {
  const prefix = Buffer.alloc(30);
  prefix.writeUInt32LE(0x04034b50, 0); // PK\x03\x04 so the sniff sees a zip
  const name = Buffer.from('bomb');
  const cdfh = Buffer.alloc(46 + name.length);
  cdfh.writeUInt32LE(0x02014b50, 0);
  cdfh.writeUInt32LE(10, 20); // compressed
  cdfh.writeUInt32LE(uncompressed >>> 0, 24); // uncompressed
  cdfh.writeUInt16LE(name.length, 28);
  name.copy(cdfh, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdfh.length, 12);
  eocd.writeUInt32LE(prefix.length, 16); // cd offset
  return Buffer.concat([prefix, cdfh, eocd]);
}

describe('convertInSandbox host guards', () => {
  it('blocks type confusion (PDF bytes in a .docx)', async () => {
    const f = join(dir, 'evil.docx');
    await writeFile(f, Buffer.from('%PDF-1.7\n...not really a docx...'));
    const r = await convertInSandbox(f, 'docx');
    expect(r.markdown).toBeNull();
    expect(r.blocked).toMatch(/not a valid docx/);
  });

  it('blocks a zip bomb before spawning the parser', async () => {
    const f = join(dir, 'bomb.docx');
    await writeFile(f, bombZip(300 * 1024 * 1024));
    const r = await convertInSandbox(f, 'docx');
    expect(r.markdown).toBeNull();
    expect(r.blocked).toMatch(/expands|ratio|archive/);
  });

  it('returns null (not blocked) for a missing file', async () => {
    const r = await convertInSandbox(join(dir, 'nope.docx'), 'docx');
    expect(r.markdown).toBeNull();
    expect(r.blocked).toBeUndefined();
  });
});
