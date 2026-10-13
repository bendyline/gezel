/**
 * Pure decoders for HuggingFace's Xet content-addressed storage format.
 *
 * HF migrated model hosting to Xet (content-defined chunking + dedup). A
 * `/resolve/<rev>/<file>` request for a Xet-backed file no longer 302s to a
 * plain CDN blob — it redirects into a CAS bridge that a naive "follow the
 * redirect and GET" client can't read (it 403s). The supported path is the
 * reconstruction protocol:
 *
 *   1. resolve (redirect: manual) → the 302 carries `X-Xet-Hash` + a `link`
 *      header with rel="xet-auth" (token mint) and rel="xet-reconstruction-info".
 *   2. GET the xet-auth endpoint → { casUrl, accessToken, exp } (anonymous
 *      works for public repos).
 *   3. GET `${casUrl}/v1/reconstructions/${xetHash}` (Bearer token) → an
 *      ordered `terms[]` (each = a xorb hash + a chunk-index range) plus
 *      `fetch_info` (per-xorb presigned `transfer.xethub.hf.co` URLs with the
 *      byte range to fetch for a given chunk range).
 *   4. For each term, fetch its xorb byte range, walk the chunks, decompress,
 *      and concatenate in term order (dropping `offset_into_first_range` bytes
 *      at the very start). sha256 of the result matches the manifest pin.
 *
 * This file is the PURE half: no network, no fs. It parses chunk headers and
 * decompresses the three schemes Xet emits. The I/O driver lives in
 * `xet-download.ts`. Every decoder here was validated against real e2b files
 * (tokenizer.json = 100% LZ4, model.safetensors = None+LZ4+bg4) by full-file
 * sha256 before this shipped — do not "simplify" the LZ4 frame handling
 * without re-checking against a bg4 file.
 *
 * Chunk header (8 bytes, little-endian):
 *   [version:u8][compressedLen:u24][scheme:u8][uncompressedLen:u24]
 * Compression schemes:
 *   0 None · 1 LZ4 (frame) · 2 ByteGroupingLZ4 (bg4: 4 byte-planes, LZ4 frame)
 *
 * NB: scheme 1/2 payloads are LZ4 *frame* format (magic 0x184D2204), NOT raw
 * blocks — the block decoder runs once per frame block.
 */

export const XET_CHUNK_HEADER_BYTES = 8;
const LZ4_FRAME_MAGIC = 0x184d2204;

const SCHEME_NONE = 0;
const SCHEME_LZ4 = 1;
const SCHEME_BG4 = 2;

/** A single reconstruction term: chunks [range.start, range.end) of a xorb. */
export interface XetTerm {
  hash: string;
  unpacked_length: number;
  range: { start: number; end: number };
}

/** A fetchable byte segment of a xorb covering chunk range [start, end). */
export interface XetFetchSegment {
  range: { start: number; end: number };
  url: string;
  url_range: { start: number; end: number };
}

export interface XetReconstruction {
  offset_into_first_range: number;
  terms: XetTerm[];
  fetch_info: Record<string, XetFetchSegment[]>;
}

/**
 * Decompress one raw LZ4 block (input-terminated) into `dst` at `dStart`.
 * Returns the number of bytes written. The block length is known exactly from
 * the enclosing frame, so there is no trailing padding and input exhaustion is
 * the correct terminator.
 */
function lz4BlockInto(src: Buffer, dst: Buffer, dStart: number): number {
  let s = 0;
  let d = dStart;
  while (s < src.length) {
    const token = src[s++]!;
    let litLen = token >> 4;
    if (litLen === 15) {
      let b: number;
      do {
        b = src[s++]!;
        litLen += b;
      } while (b === 255);
    }
    src.copy(dst, d, s, s + litLen);
    s += litLen;
    d += litLen;
    if (s >= src.length) break; // final sequence: literals only
    const offset = src[s]! | (src[s + 1]! << 8);
    s += 2;
    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b: number;
      do {
        b = src[s++]!;
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4; // MINMATCH
    let m = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++]!;
  }
  return d - dStart;
}

/** Decompress an LZ4 frame to exactly `destSize` bytes. */
export function lz4DecompressFrame(src: Buffer, destSize: number): Buffer {
  let s = 0;
  if (src.length < 7 || src.readUInt32LE(0) !== LZ4_FRAME_MAGIC) {
    throw new Error('xet: payload is not an LZ4 frame');
  }
  s += 4;
  const flg = src[s++]!;
  s++; // BD (block-max-size descriptor) — unused; output is sized by destSize
  const contentSizePresent = (flg >> 3) & 1;
  const dictIdPresent = flg & 1;
  const blockChecksum = (flg >> 4) & 1;
  const contentChecksum = (flg >> 2) & 1;
  if (contentSizePresent) s += 8;
  if (dictIdPresent) s += 4;
  s += 1; // HC header checksum

  const dst = Buffer.allocUnsafe(destSize);
  let d = 0;
  while (s + 4 <= src.length) {
    const blockSize = src.readUInt32LE(s);
    s += 4;
    if (blockSize === 0) break; // end mark
    const uncompressed = (blockSize & 0x80000000) !== 0;
    const size = blockSize & 0x7fffffff;
    const block = src.subarray(s, s + size);
    s += size;
    if (uncompressed) {
      block.copy(dst, d);
      d += size;
    } else {
      d += lz4BlockInto(block, dst, d);
    }
    if (blockChecksum) s += 4;
  }
  if (contentChecksum) s += 4;
  if (d !== destSize) {
    throw new Error(`xet: LZ4 frame produced ${d} bytes, expected ${destSize}`);
  }
  return dst;
}

/**
 * Undo bg4 byte-plane regrouping. The original data was split into 4 planes by
 * index % 4 (plane sizes floor((len - k + 3) / 4)), the planes concatenated,
 * then LZ4-compressed. We're given the already-decompressed regrouped buffer.
 */
export function bg4Unregroup(regrouped: Buffer, len: number): Buffer {
  const out = Buffer.allocUnsafe(len);
  const s0 = Math.floor((len + 3) / 4);
  const s1 = Math.floor((len + 2) / 4);
  const s2 = Math.floor((len + 1) / 4);
  let c0 = 0;
  let c1 = s0;
  let c2 = s0 + s1;
  let c3 = s0 + s1 + s2;
  for (let i = 0; i < len; i++) {
    const plane = i & 3;
    const src = plane === 0 ? c0++ : plane === 1 ? c1++ : plane === 2 ? c2++ : c3++;
    out[i] = regrouped[src]!;
  }
  return out;
}

export interface DecodedChunk {
  data: Buffer;
  /** Offset of the next chunk header within the source buffer. */
  next: number;
}

/** Decode a single chunk at `buf[off]`. */
export function decodeChunk(buf: Buffer, off: number): DecodedChunk {
  const version = buf[off]!;
  if (version !== 0) throw new Error(`xet: unsupported chunk version ${version}`);
  const compLen = buf[off + 1]! | (buf[off + 2]! << 8) | (buf[off + 3]! << 16);
  const scheme = buf[off + 4]!;
  const uncompLen = buf[off + 5]! | (buf[off + 6]! << 8) | (buf[off + 7]! << 16);
  const payload = buf.subarray(
    off + XET_CHUNK_HEADER_BYTES,
    off + XET_CHUNK_HEADER_BYTES + compLen,
  );

  let data: Buffer;
  if (scheme === SCHEME_NONE) {
    data = Buffer.from(payload);
  } else if (scheme === SCHEME_LZ4) {
    data = lz4DecompressFrame(payload, uncompLen);
  } else if (scheme === SCHEME_BG4) {
    data = bg4Unregroup(lz4DecompressFrame(payload, uncompLen), uncompLen);
  } else {
    throw new Error(`xet: unknown compression scheme ${scheme}`);
  }
  return { data, next: off + XET_CHUNK_HEADER_BYTES + compLen };
}

/**
 * Decode every chunk in a fetched xorb byte segment → one decoded buffer per
 * chunk, in order. `expectedChunks` (segment chunk-range width) guards against
 * a short/over-read.
 */
export function decodeSegmentChunks(buf: Buffer, expectedChunks: number): Buffer[] {
  const chunks: Buffer[] = [];
  let off = 0;
  while (off + XET_CHUNK_HEADER_BYTES <= buf.length && chunks.length < expectedChunks) {
    const { data, next } = decodeChunk(buf, off);
    chunks.push(data);
    off = next;
  }
  if (chunks.length !== expectedChunks) {
    throw new Error(`xet: segment decoded ${chunks.length} chunks, expected ${expectedChunks}`);
  }
  return chunks;
}

/** Parse the `link` header from a resolve 302 into a rel → url map. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/g)) {
    out[m[2]!] = m[1]!;
  }
  return out;
}
