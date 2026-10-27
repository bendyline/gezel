import { describe, expect, it } from 'vitest';
import {
  DNS_TYPE_A,
  DNS_TYPE_PTR,
  DNS_TYPE_SRV,
  DNS_TYPE_TXT,
  DnsDecodeError,
  decodeDnsMessage,
  encodeDnsMessage,
} from './dns-sd.js';

function header(fields: { id?: number; flags?: number; qd?: number; an?: number }): number[] {
  const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
  return [
    ...u16(fields.id ?? 0),
    ...u16(fields.flags ?? 0),
    ...u16(fields.qd ?? 0),
    ...u16(fields.an ?? 0),
    0,
    0,
    0,
    0,
  ];
}

const label = (s: string) => [s.length, ...Buffer.from(s)];

describe('dns-sd codec', () => {
  it('round-trips a query, including the QU bit', () => {
    const decoded = decodeDnsMessage(
      encodeDnsMessage({
        id: 4242,
        questions: [{ name: '_gezel._tcp.local', type: DNS_TYPE_PTR, unicastResponse: true }],
      }),
    );
    expect(decoded).toEqual({
      id: 4242,
      isResponse: false,
      questions: [{ name: '_gezel._tcp.local', type: DNS_TYPE_PTR, unicastResponse: true }],
      records: [],
    });
  });

  it('round-trips PTR, SRV, TXT, and A records across answer and additional sections', () => {
    const decoded = decodeDnsMessage(
      encodeDnsMessage({
        isResponse: true,
        answers: [
          {
            name: '_gezel._tcp.local',
            ttl: 120,
            data: { type: DNS_TYPE_PTR, name: 'x._gezel._tcp.local' },
          },
        ],
        additionals: [
          {
            name: 'x._gezel._tcp.local',
            ttl: 120,
            cacheFlush: true,
            data: { type: DNS_TYPE_SRV, priority: 0, weight: 0, port: 6229, target: 'x.local' },
          },
          {
            name: 'x._gezel._tcp.local',
            ttl: 120,
            data: { type: DNS_TYPE_TXT, entries: ['v=1', 'name=Werkbank'] },
          },
          { name: 'x.local', ttl: 120, data: { type: DNS_TYPE_A, address: '192.168.1.20' } },
        ],
      }),
    );
    expect(decoded.isResponse).toBe(true);
    expect(decoded.records.map((r) => r.data)).toEqual([
      { type: DNS_TYPE_PTR, name: 'x._gezel._tcp.local' },
      { type: DNS_TYPE_SRV, priority: 0, weight: 0, port: 6229, target: 'x.local' },
      { type: DNS_TYPE_TXT, entries: ['v=1', 'name=Werkbank'] },
      { type: DNS_TYPE_A, address: '192.168.1.20' },
    ]);
    expect(decoded.records[1]?.cacheFlush).toBe(true);
    expect(decoded.records[0]?.cacheFlush).toBe(false);
  });

  it('follows a compression pointer back to an earlier name', () => {
    const question = [...label('_gezel'), ...label('_tcp'), ...label('local'), 0];
    // Answer name: pointer to offset 12 (the question name).
    const packet = Buffer.from([
      ...header({ flags: 0x8400, qd: 1, an: 1 }),
      ...question,
      0,
      DNS_TYPE_PTR,
      0,
      1,
      0xc0,
      12,
      0,
      DNS_TYPE_PTR,
      0,
      1,
      0,
      0,
      0,
      120,
      0,
      6,
      ...label('box'),
      0xc0,
      12,
    ]);
    const decoded = decodeDnsMessage(packet);
    expect(decoded.records).toEqual([
      {
        name: '_gezel._tcp.local',
        ttl: 120,
        cacheFlush: false,
        data: { type: DNS_TYPE_PTR, name: 'box._gezel._tcp.local' },
      },
    ]);
  });

  it('refuses a pointer that does not point backwards, so a loop cannot spin', () => {
    // A question whose name is a pointer to itself.
    const selfLoop = Buffer.from([...header({ qd: 1 }), 0xc0, 12, 0, 1, 0, 1]);
    expect(() => decodeDnsMessage(selfLoop)).toThrow(DnsDecodeError);
    // A forward pointer to a pointer back to it.
    const pingPong = Buffer.from([...header({ qd: 1 }), 0xc0, 14, 0xc0, 12, 0, 1, 0, 1]);
    expect(() => decodeDnsMessage(pingPong)).toThrow(DnsDecodeError);
  });

  it('refuses truncated packets and record data that overruns its length', () => {
    expect(() => decodeDnsMessage(Buffer.alloc(5))).toThrow(DnsDecodeError);
    const full = encodeDnsMessage({
      isResponse: true,
      answers: [{ name: 'a.local', ttl: 1, data: { type: DNS_TYPE_A, address: '10.0.0.1' } }],
    });
    expect(() => decodeDnsMessage(full.subarray(0, full.length - 2))).toThrow(DnsDecodeError);
    // A PTR claiming 2 bytes of rdata whose name runs on past them.
    const overrun = Buffer.from([
      ...header({ flags: 0x8400, an: 1 }),
      0,
      0,
      DNS_TYPE_PTR,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      2,
      ...label('abc'),
      0,
    ]);
    expect(() => decodeDnsMessage(overrun)).toThrow(DnsDecodeError);
  });

  it('skips record types it does not know', () => {
    const packet = Buffer.from([
      ...header({ flags: 0x8400, an: 1 }),
      0,
      0,
      28, // AAAA
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      16,
      ...new Array(16).fill(0),
    ]);
    expect(decodeDnsMessage(packet).records).toEqual([]);
  });

  it('throws only DnsDecodeError on arbitrary bytes from the network', () => {
    const valid = encodeDnsMessage({
      id: 7,
      isResponse: true,
      questions: [{ name: '_gezel._tcp.local', type: DNS_TYPE_PTR }],
      answers: [
        {
          name: '_gezel._tcp.local',
          ttl: 10,
          data: { type: DNS_TYPE_PTR, name: 'x._gezel._tcp.local' },
        },
        { name: 'x._gezel._tcp.local', ttl: 10, data: { type: DNS_TYPE_TXT, entries: ['fp=ab'] } },
      ],
    });
    let seed = 1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 3000; i++) {
      const packet = Buffer.from(valid);
      const flips = 1 + (rand() % 6);
      for (let f = 0; f < flips; f++) packet[rand() % packet.length] = rand() & 0xff;
      const cut = i % 3 === 0 ? packet.subarray(0, rand() % packet.length) : packet;
      try {
        decodeDnsMessage(cut);
      } catch (err) {
        expect(err).toBeInstanceOf(DnsDecodeError);
      }
    }
  });

  // A legacy answer echoes the questions it was asked, so any name the
  // decoder hands back must encode again. Lossy UTF-8 broke that: 22 bytes of
  // 0xFF came back as 66 and the echo threw from the advertiser's socket
  // handler, ending the daemon (1.26299.99).
  it('refuses a label that is not valid UTF-8', () => {
    const packet = Buffer.from([
      ...header({ id: 0x1234, qd: 2 }),
      ...label('_gezel'),
      ...label('_tcp'),
      ...label('local'),
      0,
      0,
      DNS_TYPE_PTR,
      0,
      1,
      22,
      ...Array(22).fill(0xff),
      0,
      0,
      DNS_TYPE_A,
      0,
      1,
    ]);
    expect(() => decodeDnsMessage(packet)).toThrow(/not valid UTF-8/);
  });

  it('re-encodes every question it decodes from arbitrary bytes', () => {
    const valid = encodeDnsMessage({
      id: 3,
      questions: [
        { name: '_gezel._tcp.local', type: DNS_TYPE_PTR },
        { name: 'gezel-ab12ab12ab12ab12.local', type: DNS_TYPE_A },
      ],
    });
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 3000; i++) {
      const packet = Buffer.from(valid);
      const flips = 1 + (rand() % 6);
      for (let f = 0; f < flips; f++) packet[12 + (rand() % (packet.length - 12))] = rand() & 0xff;
      let questions: ReturnType<typeof decodeDnsMessage>['questions'];
      try {
        questions = decodeDnsMessage(packet).questions;
      } catch {
        continue;
      }
      expect(() => encodeDnsMessage({ id: 3, isResponse: true, questions })).not.toThrow();
    }
  });
});
