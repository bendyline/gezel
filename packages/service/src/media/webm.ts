/**
 * Just enough of WebM (Matroska's EBML) to describe a clip sd.cpp wrote and
 * to lift a poster frame out of it without ffmpeg: the video track's size,
 * whether there is an audio track, and the first video frame.
 *
 * sd.cpp encodes every frame as a VP8 keyframe, the same bitstream a lossy
 * WebP image carries, so the first frame becomes a poster by wrapping it in
 * a WebP container. Pure TypeScript, reads only the buffer it is given, and
 * gives up (undefined) on anything it does not recognize.
 */

const ID = {
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
  blockGroup: 0xa0,
  block: 0xa1,
  simpleBlock: 0xa3,
} as const;

/** Elements whose children this reader walks. */
const MASTERS = new Set<number>([
  ID.segment,
  ID.tracks,
  ID.trackEntry,
  ID.video,
  ID.cluster,
  ID.blockGroup,
]);

const TRACK_VIDEO = 1;
const TRACK_AUDIO = 2;

interface Element {
  id: number;
  dataStart: number;
  dataEnd: number;
}

/** A variable-length integer; `keepMarker` for element IDs, which keep their length bit. */
function readVint(
  buf: Buffer,
  at: number,
  keepMarker: boolean,
): { value: number; length: number; unknown: boolean } | null {
  const first = buf[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 8 || at + length > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = buf[at + i] as number;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function* elements(buf: Buffer, start: number, end: number): Generator<Element> {
  let at = start;
  while (at < end) {
    const id = readVint(buf, at, true);
    if (!id) return;
    const size = readVint(buf, at + id.length, false);
    if (!size) return;
    const dataStart = at + id.length + size.length;
    const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
    if (dataStart > end) return;
    yield { id: id.value, dataStart, dataEnd };
    at = dataEnd;
  }
}

function readUint(buf: Buffer, el: Element): number {
  let value = 0;
  for (let i = el.dataStart; i < el.dataEnd; i++) value = value * 256 + (buf[i] as number);
  return value;
}

interface Track {
  number?: number;
  type?: number;
  codec?: string;
  width?: number;
  height?: number;
}

interface Scan {
  tracks: Track[];
  /** The first block's frame for each track number. */
  firstFrames: Map<number, Buffer>;
}

function scan(buf: Buffer): Scan | null {
  if (buf.length < 4 || buf.readUInt32BE(0) !== 0x1a45dfa3) return null;
  const out: Scan = { tracks: [], firstFrames: new Map() };
  const visit = (start: number, end: number, track: Track | null): void => {
    for (const el of elements(buf, start, end)) {
      if (el.id === ID.trackEntry) {
        const entry: Track = {};
        visit(el.dataStart, el.dataEnd, entry);
        out.tracks.push(entry);
        continue;
      }
      if (MASTERS.has(el.id)) {
        visit(el.dataStart, el.dataEnd, track);
        continue;
      }
      if (track) {
        if (el.id === ID.trackNumber) track.number = readUint(buf, el);
        else if (el.id === ID.trackType) track.type = readUint(buf, el);
        else if (el.id === ID.codecId)
          track.codec = buf.toString('latin1', el.dataStart, el.dataEnd);
        else if (el.id === ID.pixelWidth) track.width = readUint(buf, el);
        else if (el.id === ID.pixelHeight) track.height = readUint(buf, el);
        continue;
      }
      if (el.id === ID.simpleBlock || el.id === ID.block) {
        const trackNo = readVint(buf, el.dataStart, false);
        if (!trackNo || out.firstFrames.has(trackNo.value)) continue;
        const flags = buf[el.dataStart + trackNo.length + 2];
        // Laced blocks hold several frames; sd.cpp never writes them.
        if (flags === undefined || (flags & 0x06) !== 0) continue;
        const frameStart = el.dataStart + trackNo.length + 3;
        out.firstFrames.set(trackNo.value, buf.subarray(frameStart, el.dataEnd));
      }
    }
  };
  visit(0, buf.length, null);
  return out;
}

export interface WebmVideoInfo {
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
}

export function webmVideoInfo(buf: Buffer): WebmVideoInfo | undefined {
  const s = scan(buf);
  const video = s?.tracks.find((t) => t.type === TRACK_VIDEO);
  if (!s || !video?.width || !video.height || !video.codec) return undefined;
  return {
    width: video.width,
    height: video.height,
    codec: video.codec,
    hasAudio: s.tracks.some((t) => t.type === TRACK_AUDIO),
  };
}

/** A VP8 keyframe: frame tag bit 0 clear, then the start code 9d 01 2a. */
function isVp8Keyframe(frame: Buffer): boolean {
  return (
    frame.length > 10 &&
    ((frame[0] as number) & 1) === 0 &&
    frame[3] === 0x9d &&
    frame[4] === 0x01 &&
    frame[5] === 0x2a
  );
}

/** The clip's first frame as a lossy WebP image, or undefined when it is not a VP8 keyframe. */
export function webmFirstFrameWebp(buf: Buffer): Buffer | undefined {
  const s = scan(buf);
  const video = s?.tracks.find((t) => t.type === TRACK_VIDEO && t.codec === 'V_VP8');
  const frame = video?.number !== undefined ? s?.firstFrames.get(video.number) : undefined;
  if (!frame || !isVp8Keyframe(frame)) return undefined;
  const pad = frame.length % 2;
  const header = Buffer.alloc(20);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + 8 + frame.length + pad, 4);
  header.write('WEBP', 8, 'latin1');
  header.write('VP8 ', 12, 'latin1');
  header.writeUInt32LE(frame.length, 16);
  return Buffer.concat([header, frame, Buffer.alloc(pad)]);
}
