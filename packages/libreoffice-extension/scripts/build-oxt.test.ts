import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { buildOxt, manifestEntries } from './build-oxt.mjs';

let out: string;
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), 'gezel-oxt-'));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

function entries(file: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const found = new Map<string, Buffer>();
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            found.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(found));
      zip.readEntry();
    });
  });
}

describe('buildOxt', () => {
  it('packs every file the manifest names, stamps the version, and skips caches', async () => {
    const { outFile } = await buildOxt({ outFile: join(out, 'gezel.oxt'), version: '1.26300.1' });
    const files = await entries(outFile);
    const manifest = files.get('META-INF/manifest.xml')!.toString('utf8');
    for (const entry of manifestEntries(manifest)) expect(files.has(entry)).toBe(true);
    const description = files.get('description.xml')!.toString('utf8');
    expect(description).toContain('<version value="1.26300.1"/>');
    expect(description).toContain('<identifier value="com.bendyline.gezel"/>');
    expect(files.has('python/pythonpath/gezel/panel.py')).toBe(true);
    expect(files.has('icons/gezel_26.png')).toBe(true);
    expect([...files.keys()].some((k) => k.includes('__pycache__') || k.endsWith('.pyc'))).toBe(
      false,
    );
    for (const name of ['Addons.xcu', 'Sidebar.xcu', 'Factory.xcu', 'ProtocolHandler.xcu']) {
      expect(files.get(name)!.toString('utf8')).toMatch(/^<\?xml/);
    }
  });

  it('is byte-for-byte deterministic', async () => {
    const a = await buildOxt({ outFile: join(out, 'a.oxt'), version: '1.0.0' });
    const b = await buildOxt({ outFile: join(out, 'b.oxt'), version: '1.0.0' });
    const hash = async (f: string) =>
      createHash('sha256')
        .update(await readFile(f))
        .digest('hex');
    expect(await hash(a.outFile)).toBe(await hash(b.outFile));
  });
});
