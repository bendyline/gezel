/**
 * Public media sets for the media retrieval bench, downloaded at run time
 * into a cache folder and never committed:
 *
 * - COCO Karpathy test split (images + five human captions each), rows from
 *   the Hugging Face datasets-server, images from cocodataset.org. Captions
 *   CC BY 4.0; images under their Flickr licenses.
 * - ESC-50 (2,000 five-second environmental sound clips, 50 classes), from
 *   the dataset's GitHub repository. CC BY-NC 3.0 — measurement only.
 * - MSR-VTT test 1k-A (short video clips + a caption each). The 2 GB video
 *   zip is read with HTTP range requests, so only the chosen clips download.
 *
 * Every download is checked for a plausible size and written atomically; a
 * re-run reuses the cache.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export interface ImageItem {
  id: string;
  path: string;
  captions: string[];
}

export interface AudioItem {
  id: string;
  path: string;
  category: string;
}

export interface VideoItem {
  id: string;
  path: string;
  caption: string;
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function cacheFile(path: string, produce: () => Promise<Uint8Array>): Promise<string> {
  if (existsSync(path)) return path;
  const bytes = await produce();
  if (bytes.byteLength < 64) throw new Error(`${path}: implausibly small download`);
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

async function cachedJson<T>(path: string, produce: () => Promise<T>): Promise<T> {
  if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8')) as T;
  const value = await produce();
  await writeFile(path, JSON.stringify(value));
  return value;
}

/** Run `fn` over items with at most `limit` in flight. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function fetchCocoImages(cacheDir: string, count: number): Promise<ImageItem[]> {
  const dir = join(cacheDir, 'coco');
  await mkdir(dir, { recursive: true });
  type Row = { filename: string; sentences: string[]; url: string; cocoid: number };
  const rows = await cachedJson<Row[]>(join(dir, `rows-${count}.json`), async () => {
    const out: Row[] = [];
    for (let offset = 0; out.length < count; offset += 100) {
      const res = await fetchOk(
        `https://datasets-server.huggingface.co/rows?dataset=yerevann/coco-karpathy&config=default&split=test&offset=${offset}&length=100`,
      );
      const page = (await res.json()) as { rows: Array<{ row: Row }> };
      if (page.rows.length === 0) break;
      for (const r of page.rows) out.push(r.row);
    }
    return out.slice(0, count);
  });
  return pool(rows, 8, async (row) => ({
    id: `coco-${row.cocoid}`,
    captions: row.sentences,
    path: await cacheFile(
      join(dir, row.filename),
      async () => new Uint8Array(await (await fetchOk(row.url)).arrayBuffer()),
    ),
  }));
}

const ESC50 = 'https://raw.githubusercontent.com/karolpiczak/ESC-50/master';

export async function fetchEsc50(cacheDir: string, perClass: number): Promise<AudioItem[]> {
  const dir = join(cacheDir, 'esc50');
  await mkdir(dir, { recursive: true });
  const csvPath = await cacheFile(
    join(dir, 'esc50.csv'),
    async () => new Uint8Array(await (await fetchOk(`${ESC50}/meta/esc50.csv`)).arrayBuffer()),
  );
  const lines = (await readFile(csvPath, 'utf8')).trim().split('\n').slice(1);
  const byClass = new Map<string, string[]>();
  for (const line of lines) {
    const [filename, , , category] = line.split(',');
    if (!filename || !category) continue;
    const list = byClass.get(category) ?? [];
    if (list.length < perClass) list.push(filename);
    byClass.set(category, list);
  }
  const chosen = [...byClass.entries()].flatMap(([category, files]) =>
    files.map((filename) => ({ category, filename })),
  );
  return pool(chosen, 8, async ({ category, filename }) => ({
    id: `esc50-${filename.replace(/\.wav$/, '')}`,
    category,
    path: await cacheFile(
      join(dir, filename),
      async () => new Uint8Array(await (await fetchOk(`${ESC50}/audio/${filename}`)).arrayBuffer()),
    ),
  }));
}

const MSRVTT = 'https://huggingface.co/datasets/friedrichor/MSR-VTT/resolve/main';

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

async function rangeBytes(url: string, start: number, end: number): Promise<Buffer> {
  const res = await fetchOk(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) throw new Error(`${url}: server ignored the byte range`);
  return Buffer.from(await res.arrayBuffer());
}

/** The central directory of a remote zip, via the end-of-central-directory record. */
async function remoteZipEntries(url: string): Promise<ZipEntry[]> {
  const head = await fetchOk(url, { headers: { Range: 'bytes=0-0' } });
  const total = Number(/\/(\d+)$/.exec(head.headers.get('content-range') ?? '')?.[1]);
  await head.arrayBuffer();
  if (!Number.isFinite(total)) throw new Error(`${url}: no content-range total`);
  const tailStart = Math.max(0, total - 65_557);
  const tail = await rangeBytes(url, tailStart, total - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`${url}: no end-of-central-directory record`);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  const locator = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
  if (locator >= 0 && (cdOffset === 0xffffffff || cdSize === 0xffffffff)) {
    const z64Offset = Number(tail.readBigUInt64LE(locator + 8));
    const z64 = await rangeBytes(url, z64Offset, z64Offset + 55);
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }
  const cd = await rangeBytes(url, cdOffset, cdOffset + cdSize - 1);
  const entries: ZipEntry[] = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const size = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressedSize === 0xffffffff) q += 8;
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(extra.readBigUInt64LE(q));
          q += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(extra.readBigUInt64LE(q));
      }
      e += 4 + size;
    }
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function remoteZipEntry(url: string, entry: ZipEntry): Promise<Uint8Array> {
  const header = await rangeBytes(url, entry.localOffset, entry.localOffset + 29);
  const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const data = await rangeBytes(url, dataStart, dataStart + entry.compressedSize - 1);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`${entry.name}: unsupported zip method ${entry.method}`);
}

export async function fetchMsrvtt(cacheDir: string, count: number): Promise<VideoItem[]> {
  const dir = join(cacheDir, 'msrvtt');
  await mkdir(dir, { recursive: true });
  type Row = { video_id: string; video: string; caption: string };
  const rows = (
    await cachedJson<Row[]>(
      join(dir, 'test_1k.json'),
      async () => (await fetchOk(`${MSRVTT}/msrvtt_test_1k.json`)).json() as Promise<Row[]>,
    )
  ).slice(0, count);
  const missing = rows.filter((r) => !existsSync(join(dir, r.video)));
  if (missing.length > 0) {
    const zipUrl = `${MSRVTT}/MSRVTT_Videos.zip`;
    const entries = await cachedJson(join(dir, 'zip-entries.json'), () => remoteZipEntries(zipUrl));
    const byBase = new Map(entries.map((e) => [e.name.slice(e.name.lastIndexOf('/') + 1), e]));
    await pool(missing, 4, async (row) => {
      const entry = byBase.get(row.video);
      if (!entry) throw new Error(`${row.video}: not in MSRVTT_Videos.zip`);
      await cacheFile(join(dir, row.video), () => remoteZipEntry(zipUrl, entry));
    });
  }
  return rows.map((r) => ({ id: r.video_id, caption: r.caption, path: join(dir, r.video) }));
}
