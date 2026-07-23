import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
let workspaceDir: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-archive-tools-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  workspaceDir = await svc.context.store.projectWorkspaceDir('default');
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

async function extract(body: Record<string, unknown>): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/default/tools/archive/extract`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function makeZip(entries: Array<{ name: string; content: string; attr?: number }>): Buffer {
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.from(entry.content), undefined, entry.attr);
  }
  return zip.toBuffer();
}

function replaceZipName(bytes: Buffer, from: string, to: string): Buffer {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error('zip name replacement must keep the same byte length');
  }
  const out = Buffer.from(bytes);
  const fromBytes = Buffer.from(from, 'utf8');
  const toBytes = Buffer.from(to, 'utf8');
  let offset = 0;
  while (true) {
    const hit = out.indexOf(fromBytes, offset);
    if (hit === -1) break;
    toBytes.copy(out, hit);
    offset = hit + fromBytes.length;
  }
  return out;
}

function setZipExternalAttr(bytes: Buffer, entryName: string, attr: number): Buffer {
  const out = Buffer.from(bytes);
  for (let offset = 0; offset + 46 <= out.length; offset += 1) {
    if (out.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLen = out.readUInt16LE(offset + 28);
    const name = out.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (name === entryName) {
      out.writeUInt32LE(attr >>> 0, offset + 38);
      return out;
    }
  }
  throw new Error(`central directory entry not found: ${entryName}`);
}

function centralDirectoryZip(
  entries: { name: string; compressed: number; uncompressed: number }[],
): Buffer {
  const cd = Buffer.concat(entries.map((entry) => centralDirectoryHeader(entry)));
  return Buffer.concat([cd, endOfCentralDirectory(entries.length, cd.length, 0)]);
}

function centralDirectoryHeader(entry: {
  name: string;
  compressed: number;
  uncompressed: number;
}): Buffer {
  const name = Buffer.from(entry.name, 'utf8');
  const buf = Buffer.alloc(46 + name.length);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt32LE(entry.compressed >>> 0, 20);
  buf.writeUInt32LE(entry.uncompressed >>> 0, 24);
  buf.writeUInt16LE(name.length, 28);
  name.copy(buf, 46);
  return buf;
}

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(count, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(cdSize, 12);
  buf.writeUInt32LE(cdOffset, 16);
  return buf;
}

function makeTarEntry(opts: {
  name: string;
  type: string;
  content?: string;
  linkName?: string;
}): Buffer {
  const body = Buffer.from(opts.content ?? '', 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write(opts.name, 0, Math.min(Buffer.byteLength(opts.name), 100), 'utf8');
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, body.length, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = opts.type.charCodeAt(0);
  if (opts.linkName) {
    header.write(opts.linkName, 157, Math.min(Buffer.byteLength(opts.linkName), 100), 'utf8');
  }
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarChecksum(header, checksum);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function makeTar(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024, 0)]);
}

function writeTarOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const raw = value.toString(8).padStart(length - 1, '0');
  buf.write(raw.slice(-length + 1), offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function writeTarChecksum(buf: Buffer, value: number): void {
  const raw = value.toString(8).padStart(6, '0');
  buf.write(raw.slice(-6), 148, 6, 'ascii');
  buf[154] = 0;
  buf[155] = 0x20;
}

describe('archive extraction route safety', () => {
  it('extracts a normal zip through resolved destination paths', async () => {
    await writeFile(
      join(workspaceDir, 'normal.zip'),
      makeZip([{ name: 'dir/ok.txt', content: 'ok' }]),
    );

    const res = await extract({ path: 'normal.zip', outputPath: 'unzipped' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extractedCount: number; destination: string };
    expect(body.extractedCount).toBe(1);
    expect(body.destination).toBe('unzipped');
    await expect(readFile(join(workspaceDir, 'unzipped', 'dir', 'ok.txt'), 'utf8')).resolves.toBe(
      'ok',
    );
  });

  it('rejects zip entries that traverse outside the destination', async () => {
    await writeFile(
      join(workspaceDir, 'traversal.zip'),
      replaceZipName(
        makeZip([{ name: 'xx/evil.txt', content: 'nope' }]),
        'xx/evil.txt',
        '../evil.txt',
      ),
    );

    const res = await extract({ path: 'traversal.zip', outputPath: 'zip-out' });
    expect(res.status).not.toBe(200);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/escapes|path/i);
    await expect(readFile(join(workspaceDir, 'evil.txt'), 'utf8')).rejects.toThrow();
  });

  it('rejects zip symlink entries', async () => {
    const symlinkAttr = 0o120777 * 0x10000;
    await writeFile(
      join(workspaceDir, 'symlink.zip'),
      setZipExternalAttr(makeZip([{ name: 'link', content: '/etc/passwd' }]), 'link', symlinkAttr),
    );

    const res = await extract({ path: 'symlink.zip', outputPath: 'zip-links' });
    expect(res.status).not.toBe(200);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/type is not allowed/i);
  });

  it('rejects tar traversal and special link entries', async () => {
    const fixtures = [
      {
        name: 'tar-traversal.tar',
        entry: makeTarEntry({ name: '../evil.txt', type: '0', content: 'nope' }),
        pattern: /escapes|path/i,
      },
      {
        name: 'tar-symlink.tar',
        entry: makeTarEntry({ name: 'link', type: '2', linkName: '/etc/passwd' }),
        pattern: /type is not allowed/i,
      },
      {
        name: 'tar-hardlink.tar',
        entry: makeTarEntry({ name: 'hard', type: '1', linkName: 'ok.txt' }),
        pattern: /type is not allowed/i,
      },
      {
        name: 'tar-device.tar',
        entry: makeTarEntry({ name: 'dev', type: '3' }),
        pattern: /type is not allowed/i,
      },
    ];

    for (const fixture of fixtures) {
      await writeFile(join(workspaceDir, fixture.name), makeTar([fixture.entry]));
      const res = await extract({ path: fixture.name, outputPath: `${fixture.name}-out` });
      expect(res.status, fixture.name).not.toBe(200);
      const body = (await res.json()) as { error: string };
      expect(body.error, fixture.name).toMatch(fixture.pattern);
    }
    await expect(readFile(join(workspaceDir, 'evil.txt'), 'utf8')).rejects.toThrow();
  });

  it('rejects archives that exceed entry count and compression ratio budgets', async () => {
    await writeFile(
      join(workspaceDir, 'too-many.zip'),
      centralDirectoryZip(
        Array.from({ length: 4097 }, (_, i) => ({
          name: `file-${i}.txt`,
          compressed: 1,
          uncompressed: 1,
        })),
      ),
    );
    await writeFile(
      join(workspaceDir, 'ratio.zip'),
      centralDirectoryZip([{ name: 'bomb.txt', compressed: 2000, uncompressed: 2000 * 500 }]),
    );

    for (const [path, pattern] of [
      ['too-many.zip', /entries/i],
      ['ratio.zip', /ratio/i],
    ] as const) {
      const res = await extract({ path, outputPath: `${path}-out` });
      expect(res.status, path).not.toBe(200);
      const body = (await res.json()) as { error: string };
      expect(body.error, path).toMatch(pattern);
    }
  });
});
