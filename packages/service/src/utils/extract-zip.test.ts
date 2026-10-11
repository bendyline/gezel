import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as yazl from 'yazl';
import { extractZip } from './extract-zip.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-extract-zip-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeZip(name: string, build: (zip: yazl.ZipFile) => void): Promise<string> {
  const path = join(dir, name);
  const zip = new yazl.ZipFile();
  build(zip);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
  return path;
}

describe('extractZip', () => {
  it('extracts nested files and directories, overwriting what is there', async () => {
    const archive = await writeZip('a.zip', (zip) => {
      zip.addBuffer(Buffer.from('engine'), 'gezel-llama-server.exe');
      zip.addBuffer(Buffer.from('dll'), 'lib/cuda/ggml-cuda.dll');
      zip.addEmptyDirectory('licenses/');
    });
    const out = join(dir, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'gezel-llama-server.exe'), 'stale build');

    await extractZip(archive, out);

    expect(readFileSync(join(out, 'gezel-llama-server.exe'), 'utf8')).toBe('engine');
    expect(readFileSync(join(out, 'lib', 'cuda', 'ggml-cuda.dll'), 'utf8')).toBe('dll');
    expect(existsSync(join(out, 'licenses'))).toBe(true);
  });

  // The regression: AdmZip extracted synchronously, freezing Electron's main
  // thread in embedded mode for the whole engine install.
  it('keeps the event loop turning while it inflates', async () => {
    const payload = randomBytes(16 * 1024 * 1024);
    const archive = await writeZip('big.zip', (zip) => {
      zip.addBuffer(payload, 'cublasLt64_12.dll');
    });
    let turns = 0;
    let ticking = true;
    const tick = () => {
      turns += 1;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);

    await extractZip(archive, join(dir, 'out'));
    ticking = false;

    expect(readFileSync(join(dir, 'out', 'cublasLt64_12.dll')).equals(payload)).toBe(true);
    expect(turns).toBeGreaterThan(10);
  });

  it('reports byte progress up to the unpacked total', async () => {
    const archive = await writeZip('two.zip', (zip) => {
      zip.addBuffer(randomBytes(300_000), 'a.dll');
      zip.addBuffer(randomBytes(200_000), 'b.dll');
    });
    const seen: Array<[number, number]> = [];
    await extractZip(archive, join(dir, 'out'), {
      onProgress: (bytesWritten, totalBytes) => seen.push([bytesWritten, totalBytes]),
    });

    expect(seen[0]).toEqual([0, 500_000]);
    expect(seen.at(-1)).toEqual([500_000, 500_000]);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]?.[0]).toBeGreaterThanOrEqual(seen[i - 1]?.[0] ?? 0);
    }
  });

  it('refuses a symbolic link entry before writing anything', async () => {
    const archive = await writeZip('link.zip', (zip) => {
      zip.addBuffer(Buffer.from('ok'), 'a-first.txt');
      zip.addBuffer(Buffer.from('/etc/passwd'), 'evil', { mode: 0o120777 });
    });
    const out = join(dir, 'out');
    await expect(extractZip(archive, out)).rejects.toThrow(/symbolic links/);
    expect(existsSync(join(out, 'a-first.txt'))).toBe(false);
  });

  it('rejects a file that is not a zip', async () => {
    const bogus = join(dir, 'bogus.zip');
    writeFileSync(bogus, 'not a zip at all');
    await expect(extractZip(bogus, join(dir, 'out'))).rejects.toThrow(/not a readable ZIP/);
  });

  it('stops when its signal aborts', async () => {
    const archive = await writeZip('a.zip', (zip) => {
      zip.addBuffer(Buffer.from('x'), 'x.txt');
    });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      extractZip(archive, join(dir, 'out'), { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});
