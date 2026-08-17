import assert from 'node:assert/strict';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { inspectDeb } from './verify-deb-compression.mjs';

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

function buildDeb({ dataMember, dataBytes, installedKiB, controlMember = 'control.tar.zst' }) {
  const ctl =
    controlMember === 'control.tar.zst'
      ? zstdCompressSync(controlTar(installedKiB))
      : controlTar(installedKiB);
  const data = Buffer.alloc(dataBytes, 0);
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

test('reads the data member name and installed size from a zstd deb', () => {
  const deb = buildDeb({ dataMember: 'data.tar.zst', dataBytes: 1000, installedKiB: 4 });
  const info = inspectDeb(deb);
  assert.equal(info.dataMember, 'data.tar.zst');
  assert.equal(info.installedBytes, 4096);
});

test('reports an xz deb by its data member rather than failing to parse', () => {
  // The regression this catches first: `compression: zst` silently not taking
  // effect. The control member is xz too, so the ratio is deliberately not
  // computed — the member name is the clearer diagnosis.
  const deb = buildDeb({
    dataMember: 'data.tar.xz',
    dataBytes: 1000,
    installedKiB: 4,
    controlMember: 'control.tar.xz',
  });
  const info = inspectDeb(deb);
  assert.equal(info.dataMember, 'data.tar.xz');
  assert.equal(info.installedBytes, null);
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
  // A control record without the field must not produce a NaN ratio, which
  // would compare false against the floor and pass the gate silently.
  const body = Buffer.from('Package: gezel\nVersion: 9.9.9\n', 'utf8');
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  const ctl = zstdCompressSync(
    Buffer.concat([tarHeader('./control', body.length), body, pad, Buffer.alloc(1024)]),
  );
  const data = Buffer.alloc(1000, 0);
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
