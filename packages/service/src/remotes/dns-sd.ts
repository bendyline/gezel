/**
 * The slice of the DNS wire format (RFC 1035) that multicast DNS service
 * discovery (RFC 6762 / RFC 6763) needs: questions, and PTR / SRV / TXT / A
 * records. Everything else decodes as an opaque record and is skipped.
 *
 * The decoder reads packets from anyone on the local network, so every read
 * is bounds-checked and a compression pointer may only jump backwards, which
 * is what makes a pointer loop impossible rather than merely capped. Callers
 * treat a thrown {@link DnsDecodeError} as "not for us" and drop the packet.
 * Names are encoded without compression; mDNS answers this small fit a
 * single datagram either way.
 */

export const DNS_TYPE_A = 1;
export const DNS_TYPE_PTR = 12;
export const DNS_TYPE_TXT = 16;
export const DNS_TYPE_SRV = 33;
export const DNS_TYPE_ANY = 255;

const CLASS_IN = 1;
/** Top bit of a question's class: QU, "answer me by unicast" (RFC 6762 §5.4). */
const QU_BIT = 0x8000;
/** Top bit of a record's class: cache-flush (RFC 6762 §10.2). */
const CACHE_FLUSH_BIT = 0x8000;
const FLAG_RESPONSE = 0x8000;
const FLAG_AUTHORITATIVE = 0x0400;

/** RFC 6762 §17: a multicast DNS packet is at most 9000 bytes. */
const MAX_PACKET_BYTES = 9000;
const MAX_SECTION_ENTRIES = 64;
const MAX_NAME_LENGTH = 255;

export class DnsDecodeError extends Error {}

export interface DnsQuestion {
  name: string;
  type: number;
  unicastResponse?: boolean;
}

export type DnsRecordData =
  | { type: typeof DNS_TYPE_PTR; name: string }
  | { type: typeof DNS_TYPE_SRV; priority: number; weight: number; port: number; target: string }
  | { type: typeof DNS_TYPE_TXT; entries: string[] }
  | { type: typeof DNS_TYPE_A; address: string };

export interface DnsRecord {
  name: string;
  ttl: number;
  cacheFlush?: boolean;
  data: DnsRecordData;
}

export interface DnsMessage {
  id: number;
  isResponse: boolean;
  questions: DnsQuestion[];
  /** Answer, authority, and additional sections together, unknown types dropped. */
  records: DnsRecord[];
}

export function sameDnsName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ── Encoding ────────────────────────────────────────────────────────────

class Writer {
  private chunks: Buffer[] = [];

  u8(v: number): void {
    this.chunks.push(Buffer.from([v & 0xff]));
  }
  u16(v: number): void {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v & 0xffff);
    this.chunks.push(b);
  }
  u32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    this.chunks.push(b);
  }
  bytes(b: Buffer): void {
    this.chunks.push(b);
  }
  name(name: string): void {
    this.bytes(encodeName(name));
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new Error(`DNS label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  const out = Buffer.concat(parts);
  if (out.length > MAX_NAME_LENGTH) throw new Error(`DNS name too long: ${name}`);
  return out;
}

function encodeRecordData(data: DnsRecordData): Buffer {
  const w = new Writer();
  switch (data.type) {
    case DNS_TYPE_PTR:
      w.name(data.name);
      break;
    case DNS_TYPE_SRV:
      w.u16(data.priority);
      w.u16(data.weight);
      w.u16(data.port);
      w.name(data.target);
      break;
    case DNS_TYPE_TXT:
      // An empty TXT record is a single zero-length string (RFC 6763 §6.1).
      for (const entry of data.entries.length > 0 ? data.entries : ['']) {
        const bytes = Buffer.from(entry, 'utf8');
        if (bytes.length > 255) throw new Error('TXT entry longer than 255 bytes');
        w.u8(bytes.length);
        w.bytes(bytes);
      }
      break;
    case DNS_TYPE_A:
      w.bytes(Buffer.from(data.address.split('.').map((octet) => Number(octet) & 0xff)));
      break;
  }
  return w.toBuffer();
}

export function encodeDnsMessage(message: {
  id?: number;
  isResponse?: boolean;
  questions?: DnsQuestion[];
  answers?: DnsRecord[];
  additionals?: DnsRecord[];
}): Buffer {
  const questions = message.questions ?? [];
  const answers = message.answers ?? [];
  const additionals = message.additionals ?? [];
  const w = new Writer();
  w.u16(message.id ?? 0);
  w.u16(message.isResponse ? FLAG_RESPONSE | FLAG_AUTHORITATIVE : 0);
  w.u16(questions.length);
  w.u16(answers.length);
  w.u16(0);
  w.u16(additionals.length);
  for (const q of questions) {
    w.name(q.name);
    w.u16(q.type);
    w.u16(CLASS_IN | (q.unicastResponse ? QU_BIT : 0));
  }
  for (const r of [...answers, ...additionals]) {
    const rdata = encodeRecordData(r.data);
    w.name(r.name);
    w.u16(r.data.type);
    w.u16(CLASS_IN | (r.cacheFlush ? CACHE_FLUSH_BIT : 0));
    w.u32(r.ttl);
    w.u16(rdata.length);
    w.bytes(rdata);
  }
  return w.toBuffer();
}

// ── Decoding ────────────────────────────────────────────────────────────

class Reader {
  constructor(
    private readonly buf: Buffer,
    public offset = 0,
  ) {}

  private need(n: number): void {
    if (this.offset + n > this.buf.length) throw new DnsDecodeError('truncated packet');
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  slice(n: number): Buffer {
    this.need(n);
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  name(): string {
    const labels: string[] = [];
    let length = 0;
    let pos = this.offset;
    let resumeAt: number | null = null;
    // Each jump must land strictly before the pointer that made it, so the
    // walk always moves toward the start of the packet and terminates.
    let floor = pos;
    for (;;) {
      if (pos >= this.buf.length) throw new DnsDecodeError('name runs past the packet');
      const len = this.buf[pos]!;
      if (len === 0) {
        pos += 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        if (pos + 1 >= this.buf.length) throw new DnsDecodeError('truncated name pointer');
        const target = ((len & 0x3f) << 8) | this.buf[pos + 1]!;
        if (target >= floor) throw new DnsDecodeError('name pointer does not point backwards');
        if (resumeAt === null) resumeAt = pos + 2;
        floor = target;
        pos = target;
        continue;
      }
      if ((len & 0xc0) !== 0) throw new DnsDecodeError('unsupported label type');
      if (pos + 1 + len > this.buf.length) throw new DnsDecodeError('label runs past the packet');
      length += len + 1;
      if (length > MAX_NAME_LENGTH) throw new DnsDecodeError('name too long');
      labels.push(this.buf.toString('utf8', pos + 1, pos + 1 + len));
      pos += 1 + len;
    }
    this.offset = resumeAt ?? pos;
    return labels.join('.');
  }
}

function decodeRecordData(
  type: number,
  rdata: Buffer,
  packet: Buffer,
  rdataOffset: number,
): DnsRecordData | null {
  const withinRdata = (r: Reader): void => {
    if (r.offset > rdataOffset + rdata.length) {
      throw new DnsDecodeError('record data overruns its length');
    }
  };
  switch (type) {
    case DNS_TYPE_PTR: {
      const r = new Reader(packet, rdataOffset);
      const name = r.name();
      withinRdata(r);
      return { type, name };
    }
    case DNS_TYPE_SRV: {
      const r = new Reader(packet, rdataOffset);
      const priority = r.u16();
      const weight = r.u16();
      const port = r.u16();
      const target = r.name();
      withinRdata(r);
      return { type, priority, weight, port, target };
    }
    case DNS_TYPE_TXT: {
      const entries: string[] = [];
      const r = new Reader(rdata);
      while (r.offset < rdata.length) {
        const len = r.u8();
        if (len > 0) entries.push(r.slice(len).toString('utf8'));
      }
      return { type, entries };
    }
    case DNS_TYPE_A:
      if (rdata.length !== 4) throw new DnsDecodeError('A record is not 4 bytes');
      return { type, address: Array.from(rdata).join('.') };
    default:
      return null;
  }
}

export function decodeDnsMessage(packet: Buffer): DnsMessage {
  if (packet.length < 12) throw new DnsDecodeError('packet shorter than a DNS header');
  if (packet.length > MAX_PACKET_BYTES) throw new DnsDecodeError('packet too large');
  const r = new Reader(packet);
  const id = r.u16();
  const flags = r.u16();
  const counts = [r.u16(), r.u16(), r.u16(), r.u16()];
  if (counts.some((n) => n > MAX_SECTION_ENTRIES)) {
    throw new DnsDecodeError('too many entries');
  }
  const [qdcount = 0, ancount = 0, nscount = 0, arcount = 0] = counts;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qdcount; i++) {
    const name = r.name();
    const type = r.u16();
    const klass = r.u16();
    questions.push({ name, type, unicastResponse: (klass & QU_BIT) !== 0 });
  }
  const records: DnsRecord[] = [];
  for (let i = 0; i < ancount + nscount + arcount; i++) {
    const name = r.name();
    const type = r.u16();
    const klass = r.u16();
    const ttl = r.u32();
    const rdlength = r.u16();
    const rdataOffset = r.offset;
    const rdata = r.slice(rdlength);
    // Names inside rdata may point anywhere earlier in the packet, so the
    // name-bearing types decode against the whole packet, then must not
    // have read past their own rdata.
    const data = decodeRecordData(type, rdata, packet, rdataOffset);
    if (!data) continue;
    records.push({ name, ttl, cacheFlush: (klass & CACHE_FLUSH_BIT) !== 0, data });
  }
  return { id, isResponse: (flags & FLAG_RESPONSE) !== 0, questions, records };
}
