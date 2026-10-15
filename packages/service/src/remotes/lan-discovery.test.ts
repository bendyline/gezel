import { afterEach, describe, expect, it } from 'vitest';
import {
  DNS_TYPE_A,
  DNS_TYPE_PTR,
  DNS_TYPE_SRV,
  DNS_TYPE_TXT,
  decodeDnsMessage,
  encodeDnsMessage,
} from './dns-sd.js';
import {
  type AdvertisedServer,
  GEZEL_SERVICE_TYPE,
  announcement,
  answerQuery,
  createLanAdvertiser,
  createLanBrowser,
  discoveredServersIn,
  displayHostname,
  lanDiscoveryEnabled,
} from './lan-discovery.js';

const FP = 'ab12'.repeat(16);
const SERVER: AdvertisedServer = {
  port: 6229,
  fingerprint: FP,
  name: 'Werkbank',
  addresses: ['192.168.1.20', '10.0.0.4'],
};

function ptrQuery(id = 99) {
  return decodeDnsMessage(
    encodeDnsMessage({ id, questions: [{ name: GEZEL_SERVICE_TYPE, type: DNS_TYPE_PTR }] }),
  );
}

describe('lanDiscoveryEnabled', () => {
  it('is on unless switched off', () => {
    expect(lanDiscoveryEnabled({})).toBe(true);
    expect(lanDiscoveryEnabled({ GEZEL_LAN_DISCOVERY: 'off' })).toBe(false);
    expect(lanDiscoveryEnabled({ GEZEL_LAN_DISCOVERY: '0' })).toBe(false);
    expect(lanDiscoveryEnabled({ GEZEL_LAN_DISCOVERY: 'on' })).toBe(true);
  });
});

describe('displayHostname', () => {
  it('drops the .local suffix macOS adds', () => {
    expect(displayHostname('Mikes-MacBook-Pro.local')).toBe('Mikes-MacBook-Pro');
    expect(displayHostname('DESKTOP-7Q2')).toBe('DESKTOP-7Q2');
    expect(displayHostname('')).toBe('gezel');
  });
});

describe('answerQuery', () => {
  it('answers a legacy PTR query by echoing its id and questions with short TTLs', () => {
    const response = answerQuery(ptrQuery(1234), SERVER, true);
    expect(response).not.toBeNull();
    const decoded = decodeDnsMessage(response!);
    expect(decoded.id).toBe(1234);
    expect(decoded.isResponse).toBe(true);
    expect(decoded.questions).toHaveLength(1);
    expect(decoded.records.every((r) => r.ttl <= 10 && !r.cacheFlush)).toBe(true);
    expect(decoded.records.map((r) => r.data.type)).toEqual([
      DNS_TYPE_PTR,
      DNS_TYPE_SRV,
      DNS_TYPE_TXT,
      DNS_TYPE_A,
      DNS_TYPE_A,
    ]);
  });

  it('answers a standard query with id 0 and no echoed question', () => {
    const decoded = decodeDnsMessage(answerQuery(ptrQuery(), SERVER, false)!);
    expect(decoded.id).toBe(0);
    expect(decoded.questions).toEqual([]);
    expect(decoded.records.find((r) => r.data.type === DNS_TYPE_SRV)?.cacheFlush).toBe(true);
  });

  it('answers a direct A question for its host name', () => {
    const query = decodeDnsMessage(
      encodeDnsMessage({
        questions: [{ name: `gezel-${FP.slice(0, 16)}.local`, type: DNS_TYPE_A }],
      }),
    );
    const decoded = decodeDnsMessage(answerQuery(query, SERVER, false)!);
    expect(decoded.records.slice(0, 2).map((r) => r.data)).toEqual([
      { type: DNS_TYPE_A, address: '192.168.1.20' },
      { type: DNS_TYPE_A, address: '10.0.0.4' },
    ]);
  });

  it('stays quiet about other services and never answers a response', () => {
    const other = decodeDnsMessage(
      encodeDnsMessage({ questions: [{ name: '_airplay._tcp.local', type: DNS_TYPE_PTR }] }),
    );
    expect(answerQuery(other, SERVER, true)).toBeNull();
    expect(answerQuery(decodeDnsMessage(announcement(SERVER)), SERVER, true)).toBeNull();
  });
});

describe('discoveredServersIn', () => {
  const now = 1_000;

  it('reads a server from an answer and dials the address the answer came from', () => {
    const response = decodeDnsMessage(answerQuery(ptrQuery(), SERVER, true)!);
    expect(discoveredServersIn(response, '10.0.0.4', now)).toEqual([
      {
        name: 'Werkbank',
        fingerprint: FP,
        address: '10.0.0.4',
        port: 6229,
        baseUrl: 'https://10.0.0.4:6229',
        lastSeenAt: now,
      },
    ]);
  });

  it('dials an advertised address when the answer came from one the listener is not bound to', () => {
    const bound = { ...SERVER, addresses: ['192.168.1.20'] };
    const response = decodeDnsMessage(answerQuery(ptrQuery(), bound, true)!);
    expect(discoveredServersIn(response, '10.0.0.4', now)[0]?.baseUrl).toBe(
      'https://192.168.1.20:6229',
    );
  });

  it('ignores a goodbye, a missing fingerprint, and control characters in the name', () => {
    expect(
      discoveredServersIn(decodeDnsMessage(announcement(SERVER, 0)), '192.168.1.20', now),
    ).toEqual([]);
    const instance = `x.${GEZEL_SERVICE_TYPE}`;
    const noFp = decodeDnsMessage(
      encodeDnsMessage({
        isResponse: true,
        answers: [
          { name: GEZEL_SERVICE_TYPE, ttl: 10, data: { type: DNS_TYPE_PTR, name: instance } },
          {
            name: instance,
            ttl: 10,
            data: { type: DNS_TYPE_SRV, priority: 0, weight: 0, port: 6229, target: 'x.local' },
          },
          { name: instance, ttl: 10, data: { type: DNS_TYPE_TXT, entries: ['v=1', 'fp=nope'] } },
        ],
      }),
    );
    expect(discoveredServersIn(noFp, '192.168.1.20', now)).toEqual([]);
    const noisy = decodeDnsMessage(
      answerQuery(ptrQuery(), { ...SERVER, name: 'Werk\u0007bank\n' }, true)!,
    );
    expect(discoveredServersIn(noisy, '192.168.1.20', now)[0]?.name).toBe('Werkbank');
  });
});

describe('advertiser and browser over loopback', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  it('a browser finds an advertised server, and loses it once advertising stops', async () => {
    const advertiser = createLanAdvertiser({ port: 0, multicast: false });
    cleanup.push(() => advertiser.stop());
    await advertiser.advertise({ ...SERVER, addresses: ['127.0.0.1'] });
    const port = advertiser.boundPort();
    expect(port).toBeGreaterThan(0);

    const browser = createLanBrowser({
      target: { address: '127.0.0.1', port: port! },
      requeryMs: 0,
      expireMs: 400,
    });
    cleanup.push(() => browser.close());

    const found = await browser.browse({ waitMs: 200 });
    expect(found).toEqual([
      expect.objectContaining({
        name: 'Werkbank',
        fingerprint: FP,
        baseUrl: 'https://127.0.0.1:6229',
      }),
    ]);

    await advertiser.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await browser.browse()).toEqual([]);
  });

  it('does not advertise without an address a peer could dial', async () => {
    const advertiser = createLanAdvertiser({ port: 0, multicast: false });
    cleanup.push(() => advertiser.stop());
    await advertiser.advertise({ ...SERVER, addresses: [] });
    expect(advertiser.boundPort()).toBeUndefined();
  });
});
