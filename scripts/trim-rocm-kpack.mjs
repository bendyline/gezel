#!/usr/bin/env node
/**
 * Copy an AMD `.kpack` kernel pack, keeping only the libraries llama.cpp uses.
 *
 * TheRock ships rocBLAS's device code outside the library, one pack per GPU
 * architecture (`blas_lib_gfx1201.kpack`), and that pack also holds rocSOLVER's
 * and rocSPARSE's kernels: on gfx1201, 23.5 MB rocSOLVER, 12.5 MB rocSPARSE,
 * 4.8 MB rocBLAS. ggml's ROCm backend calls rocBLAS (through hipBLAS) and
 * nothing else, and the frames are zstd-compressed already, so the pack is the
 * one part of the ROCm payload compression cannot shrink: ~41 MB per target
 * untrimmed against ~5 MB trimmed.
 *
 * Every kept kernel frame is copied byte for byte; only the table of contents
 * is rebuilt (renumbered ordinals, dropped entries, new offsets). Format, from
 * rocm-systems shared/kpack/docs/runtime_api.md:
 *
 *   header   "KPAK" u32 version  u64 toc offset   (16 bytes, padded to 64)
 *   blob     u32 frame count, then per frame: u32 size + zstd frame
 *   toc      msgpack map; `toc[<binary>#<n>][<gfx>].ordinal` indexes a frame
 *
 * Usage:
 *   node scripts/trim-rocm-kpack.mjs <in.kpack> <out.kpack> [--keep <regex>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Binaries whose kernels ggml-hip can reach: rocBLAS, and hipBLASLt behind it. */
export const DEFAULT_KEEP = /(?:^|\/)(?:lib)?(?:rocblas|hipblaslt)[^/]*$/i;

const HEADER_BYTES = 64;

// ── MessagePack, the subset a kpack TOC uses ─────────────────────────────

export function decodeMsgpack(buffer, start = 0) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = start;
  const str = (n) => {
    const s = buffer.toString('utf8', pos, pos + n);
    pos += n;
    return s;
  };
  const read = () => {
    const b = buffer[pos++];
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f);
    if (b >= 0x90 && b <= 0x9f) return array(b & 0x0f);
    if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4: {
        const n = buffer[pos++];
        pos += n;
        return buffer.subarray(pos - n, pos);
      }
      case 0xca:
        pos += 4;
        return view.getFloat32(pos - 4);
      case 0xcb:
        pos += 8;
        return view.getFloat64(pos - 8);
      case 0xcc:
        return buffer[pos++];
      case 0xcd:
        pos += 2;
        return view.getUint16(pos - 2);
      case 0xce:
        pos += 4;
        return view.getUint32(pos - 4);
      case 0xcf:
        pos += 8;
        return Number(view.getBigUint64(pos - 8));
      case 0xd0:
        return view.getInt8(pos++);
      case 0xd1:
        pos += 2;
        return view.getInt16(pos - 2);
      case 0xd2:
        pos += 4;
        return view.getInt32(pos - 4);
      case 0xd3:
        pos += 8;
        return Number(view.getBigInt64(pos - 8));
      case 0xd9:
        return str(buffer[pos++]);
      case 0xda:
        pos += 2;
        return str(view.getUint16(pos - 2));
      case 0xdb:
        pos += 4;
        return str(view.getUint32(pos - 4));
      case 0xdc:
        pos += 2;
        return array(view.getUint16(pos - 2));
      case 0xdd:
        pos += 4;
        return array(view.getUint32(pos - 4));
      case 0xde:
        pos += 2;
        return map(view.getUint16(pos - 2));
      case 0xdf:
        pos += 4;
        return map(view.getUint32(pos - 4));
      default:
        throw new Error(`unsupported msgpack type 0x${b.toString(16)} at ${pos - 1}`);
    }
  };
  const array = (n) => Array.from({ length: n }, () => read());
  const map = (n) => {
    const out = {};
    for (let i = 0; i < n; i += 1) {
      const key = read();
      out[key] = read();
    }
    return out;
  };
  return read();
}

export function encodeMsgpack(value) {
  const parts = [];
  const u = (bytes) => parts.push(Buffer.from(bytes));
  const write = (v) => {
    if (v === null || v === undefined) return u([0xc0]);
    if (v === true) return u([0xc3]);
    if (v === false) return u([0xc2]);
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) {
        const b = Buffer.alloc(9);
        b[0] = 0xcb;
        b.writeDoubleBE(v, 1);
        return parts.push(b);
      }
      if (v >= 0 && v <= 0x7f) return u([v]);
      if (v < 0 && v >= -32) return u([v + 0x100]);
      if (v >= 0) {
        if (v <= 0xff) return u([0xcc, v]);
        let b;
        if (v <= 0xffff) {
          b = Buffer.alloc(3);
          b[0] = 0xcd;
          b.writeUInt16BE(v, 1);
        } else if (v <= 0xffffffff) {
          b = Buffer.alloc(5);
          b[0] = 0xce;
          b.writeUInt32BE(v, 1);
        } else {
          b = Buffer.alloc(9);
          b[0] = 0xcf;
          b.writeBigUInt64BE(BigInt(v), 1);
        }
        return parts.push(b);
      }
      const b = Buffer.alloc(9);
      b[0] = 0xd3;
      b.writeBigInt64BE(BigInt(v), 1);
      return parts.push(b);
    }
    if (typeof v === 'string') {
      const s = Buffer.from(v, 'utf8');
      const n = s.length;
      if (n <= 31) u([0xa0 | n]);
      else if (n <= 0xff) u([0xd9, n]);
      else if (n <= 0xffff) u([0xda, n >> 8, n & 0xff]);
      else {
        const b = Buffer.alloc(5);
        b[0] = 0xdb;
        b.writeUInt32BE(n, 1);
        parts.push(b);
      }
      return parts.push(s);
    }
    if (Buffer.isBuffer(v)) {
      if (v.length > 0xff) throw new Error('bin longer than 255 bytes is not used by kpack');
      u([0xc4, v.length]);
      return parts.push(v);
    }
    if (Array.isArray(v)) {
      header(v.length, 0x90, 0xdc, 0xdd);
      for (const item of v) write(item);
      return;
    }
    const entries = Object.entries(v);
    header(entries.length, 0x80, 0xde, 0xdf);
    for (const [key, item] of entries) {
      write(key);
      write(item);
    }
  };
  const header = (n, fix, x16, x32) => {
    if (n <= 15) return u([fix | n]);
    if (n <= 0xffff) return u([x16, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = x32;
    b.writeUInt32BE(n, 1);
    parts.push(b);
  };
  write(value);
  return Buffer.concat(parts);
}

// ── Pack ─────────────────────────────────────────────────────────────────

export function parseKpack(buffer) {
  if (buffer.toString('latin1', 0, 4) !== 'KPAK')
    throw new Error('not a kpack archive (no KPAK magic)');
  const version = buffer.readUInt32LE(4);
  if (version !== 1) throw new Error(`unsupported kpack version ${version}`);
  const tocOffset = Number(buffer.readBigUInt64LE(8));
  const toc = decodeMsgpack(buffer, tocOffset);
  if (toc.compression_scheme !== 'zstd-per-kernel') {
    throw new Error(`unsupported kpack compression ${toc.compression_scheme}`);
  }
  let pos = toc.zstd_offset;
  const count = buffer.readUInt32LE(pos);
  pos += 4;
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const size = buffer.readUInt32LE(pos);
    frames.push(buffer.subarray(pos + 4, pos + 4 + size));
    pos += 4 + size;
  }
  return { version, toc, frames };
}

export function buildKpack({ version = 1, toc, frames }) {
  const blobParts = [Buffer.alloc(4)];
  blobParts[0].writeUInt32LE(frames.length, 0);
  for (const frame of frames) {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(frame.length, 0);
    blobParts.push(size, frame);
  }
  const blob = Buffer.concat(blobParts);
  const tocOut = { ...toc, zstd_offset: HEADER_BYTES, zstd_size: blob.length };
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('KPAK', 0, 'latin1');
  header.writeUInt32LE(version, 4);
  header.writeBigUInt64LE(BigInt(HEADER_BYTES + blob.length), 8);
  return Buffer.concat([header, blob, encodeMsgpack(tocOut)]);
}

/** A pack holding only the entries whose binary (`<path>#<n>` key) matches `keep`. */
export function trimKpack(buffer, keep = DEFAULT_KEEP) {
  const { version, toc, frames } = parseKpack(buffer);
  const kept = [];
  const remap = new Map();
  const outToc = {};
  for (const [binary, arches] of Object.entries(toc.toc)) {
    if (!keep.test(binary.replace(/#\d+$/, ''))) continue;
    const outArches = {};
    for (const [arch, entry] of Object.entries(arches)) {
      if (!remap.has(entry.ordinal)) {
        remap.set(entry.ordinal, kept.length);
        kept.push(frames[entry.ordinal]);
      }
      outArches[arch] = { ...entry, ordinal: remap.get(entry.ordinal) };
    }
    outToc[binary] = outArches;
  }
  if (kept.length === 0) throw new Error(`no kpack entry matches ${keep}`);
  return {
    buffer: buildKpack({ version, toc: { ...toc, toc: outToc }, frames: kept }),
    kept: kept.length,
    dropped: frames.length - kept.length,
  };
}

function main(argv) {
  const [input, output, ...rest] = argv;
  if (!input || !output) {
    console.error('usage: trim-rocm-kpack.mjs <in.kpack> <out.kpack> [--keep <regex>]');
    process.exit(2);
  }
  const keepIndex = rest.indexOf('--keep');
  const keep = keepIndex >= 0 ? new RegExp(rest[keepIndex + 1], 'i') : DEFAULT_KEEP;
  const source = readFileSync(input);
  const result = trimKpack(source, keep);
  writeFileSync(output, result.buffer);
  console.log(
    `[kpack] ${input} -> ${output}: kept ${result.kept} kernels, dropped ${result.dropped} ` +
      `(${(source.length / 2 ** 20).toFixed(1)} MB -> ${(result.buffer.length / 2 ** 20).toFixed(1)} MB)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
