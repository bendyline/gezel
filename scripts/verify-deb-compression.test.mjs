import assert from 'node:assert/strict';
import test from 'node:test';
import { constants, createZstdCompress, zstdCompressSync } from 'node:zlib';
import { MIN_WINDOW_LOG, inspectDeb, zstdWindowLog } from './verify-deb-compression.mjs';

/** The first bytes of a multi-segment zstd frame with the given window. */
function zstdFrameHeader(windowLog) {
  return Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, (windowLog - 10) << 3, 0, 0, 0, 0]);
}

/**
 * Compress the way fpm does — tar piped into zstd, so the frame starts before
 * the input size is known. Several writes keep libzstd from seeing the whole
 * input in its first call, which would let it shrink the window to fit.
 */
function streamCompress(level) {
  return new Promise((resolve, reject) => {
    const z = createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: level } });
    const out = [];
    z.on('data', (chunk) => out.push(chunk));
    z.on('end', () => resolve(Buffer.concat(out)));
    z.on('error', reject);
    for (let i = 0; i < 4; i++) z.write(Buffer.alloc(64 * 1024, i));
    z.end();
  });
}

/** Minimal ustar header for a single small file. */
function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'ascii');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar  \0', 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function controlTar(installedKiB) {
  const body = Buffer.from(
    `Package: gezel\nVersion: 9.9.9\nArchitecture: arm64\nInstalled-Size: ${installedKiB}\n`,
    'utf8',
  );
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([tarHeader('./control', body.length), body, pad, Buffer.alloc(1024)]);
}

function arMember(name, size) {
  const h = Buffer.alloc(60, 0x20);
  h.write(`${name}/`, 0);
  h.write('0', 16);
  h.write('0', 28);
  h.write('0', 34);
  h.write('100644', 40);
  h.write(String(size), 48);
  h.write('`\n', 58);
  return h;
}

function buildDeb({ dataMember, data, installedKiB, controlMember = 'control.tar.zst' }) {
  const ctl =
    controlMember === 'control.tar.zst'
      ? zstdCompressSync(controlTar(installedKiB))
      : controlTar(installedKiB);
  const parts = [
    Buffer.from('!<arch>\n', 'binary'),
    arMember('debian-binary', 4),
    Buffer.from('2.0\n'),
    arMember(controlMember, ctl.length),
    ctl,
    ...(ctl.length % 2 ? [Buffer.alloc(1)] : []),
    arMember(dataMember, data.length),
    data,
  ];
  return Buffer.concat(parts);
}

test('reads the data member, window, and installed size from a zstd deb', () => {
  const deb = buildDeb({ dataMember: 'data.tar.zst', data: zstdFrameHeader(21), installedKiB: 4 });
  const info = inspectDeb(deb);
  assert.equal(info.dataMember, 'data.tar.zst');
  assert.equal(info.windowLog, 21);
  assert.equal(info.installedBytes, 4096);
});

test('reports an xz deb by its data member rather than failing to parse', () => {
  // The regression this catches first: `compression: zst` silently not taking
  // effect. The control member is xz too, so nothing else is decoded — the
  // member name is the clearer diagnosis.
  const deb = buildDeb({
    dataMember: 'data.tar.xz',
    data: Buffer.alloc(1000, 0),
    installedKiB: 4,
    controlMember: 'control.tar.xz',
  });
  const info = inspectDeb(deb);
  assert.equal(info.dataMember, 'data.tar.xz');
  assert.equal(info.windowLog, null);
  assert.equal(info.installedBytes, null);
});

test('rejects a data.tar.zst member that is not zstd', () => {
  const deb = buildDeb({
    dataMember: 'data.tar.zst',
    data: Buffer.alloc(1000, 0),
    installedKiB: 4,
  });
  assert.throws(() => inspectDeb(deb), /does not start with a zstd frame/);
});

test('reports a single-segment frame as having no window', () => {
  const frame = zstdFrameHeader(21);
  frame[4] = 0x20;
  assert.equal(zstdWindowLog(frame), null);
});

test('libzstd still ties the level to the window the gate reads', async () => {
  // The whole gate rests on this table. fpm's dash bug turns our `0` into -0,
  // which is still the default level 3; a dropped `0` becomes -3, and a
  // raised one becomes -9.
  for (const level of [0, 3]) {
    assert.ok(zstdWindowLog(await streamCompress(level)) >= MIN_WINDOW_LOG, `level ${level}`);
  }
  for (const level of [-9, -3, 1, 2]) {
    assert.ok(zstdWindowLog(await streamCompress(level)) < MIN_WINDOW_LOG, `level ${level}`);
  }
});

test('rejects a file that is not an ar archive', () => {
  assert.throws(
    () => inspectDeb(Buffer.from('this is not a deb at all, really')),
    /not an ar archive/,
  );
});

test('rejects an archive with no data member', () => {
  const ctl = zstdCompressSync(controlTar(4));
  const deb = Buffer.concat([
    Buffer.from('!<arch>\n', 'binary'),
    arMember('debian-binary', 4),
    Buffer.from('2.0\n'),
    arMember('control.tar.zst', ctl.length),
    ctl,
    ...(ctl.length % 2 ? [Buffer.alloc(1)] : []),
  ]);
  assert.throws(() => inspectDeb(deb), /no data\.tar member/);
});

test('surfaces a missing Installed-Size as null rather than NaN', () => {
  // A control record without the field must leave the ratio out of the log,
  // not print a NaN one.
  const body = Buffer.from('Package: gezel\nVersion: 9.9.9\n', 'utf8');
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  const ctl = zstdCompressSync(
    Buffer.concat([tarHeader('./control', body.length), body, pad, Buffer.alloc(1024)]),
  );
  const data = zstdFrameHeader(21);
  const deb = Buffer.concat([
    Buffer.from('!<arch>\n', 'binary'),
    arMember('debian-binary', 4),
    Buffer.from('2.0\n'),
    arMember('control.tar.zst', ctl.length),
    ctl,
    ...(ctl.length % 2 ? [Buffer.alloc(1)] : []),
    arMember('data.tar.zst', data.length),
    data,
  ]);
  assert.equal(inspectDeb(deb).installedBytes, null);
});
