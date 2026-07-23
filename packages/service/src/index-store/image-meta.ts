/**
 * Zero-dependency image dimension reader. Parses just enough of the file
 * header to get width/height/format for PNG, JPEG, GIF, and WebP — the
 * deterministic, no-model part of the image pipeline (Phase 5). Returns null
 * for formats we don't recognise.
 */

export interface ImageMeta {
  format: 'png' | 'jpeg' | 'gif' | 'webp';
  width: number;
  height: number;
}

export function readImageMeta(buf: Buffer): ImageMeta | null {
  if (buf.length < 24) return null;

  // PNG: 8-byte signature, then IHDR (width @16, height @20, big-endian).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", width/height little-endian @6/@8.
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // JPEG: scan segments for a Start-Of-Frame marker (0xFFC0–C3, C5–C7, C9–CB).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1]!;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb);
      if (isSof) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        return { format: 'jpeg', width, height };
      }
      // Skip this segment using its length field.
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      off += 2 + len;
    }
    return null;
  }

  // WebP: "RIFF"...."WEBP" then a VP8 / VP8L / VP8X chunk.
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8 ' && buf.length >= 30) {
      // Lossy: dimensions are 14-bit at offset 26/28 (mask off the top bits).
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { format: 'webp', width, height };
    }
    if (fourcc === 'VP8L' && buf.length >= 25) {
      // Lossless: 1 signature byte then 14+14 bits packed.
      const b0 = buf[21]!;
      const b1 = buf[22]!;
      const b2 = buf[23]!;
      const b3 = buf[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { format: 'webp', width, height };
    }
    if (fourcc === 'VP8X' && buf.length >= 30) {
      // Extended: 24-bit (value+1) at 24/27.
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { format: 'webp', width, height };
    }
  }

  return null;
}
