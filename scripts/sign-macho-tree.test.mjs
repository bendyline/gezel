import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { findMachOBinaries, isMachOMagic } from './sign-macho-tree.mjs';

const magic = (value) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
};

describe('isMachOMagic', () => {
  it('accepts every Mach-O magic, both byte orders', () => {
    for (const value of [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]) {
      assert.equal(isMachOMagic(magic(value)), true, value.toString(16));
    }
  });

  it('rejects ELF, PE, plain text, and short reads', () => {
    assert.equal(isMachOMagic(Buffer.from('\x7fELF', 'binary')), false);
    assert.equal(isMachOMagic(Buffer.from('MZ\x90\x00', 'binary')), false);
    assert.equal(isMachOMagic(Buffer.from('#!/u', 'utf8')), false);
    assert.equal(isMachOMagic(Buffer.alloc(3)), false);
    assert.equal(isMachOMagic(null), false);
  });
});

describe('findMachOBinaries', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-macho-'));
    await mkdir(join(dir, 'nested', 'deep'), { recursive: true });
    // No extension, exactly like node-pty's spawn-helper — the case that
    // extension-based detection would miss.
    await writeFile(join(dir, 'nested', 'deep', 'spawn-helper'), magic(0xfeedfacf));
    await writeFile(join(dir, 'pty.node'), magic(0xcffaedfe));
    await writeFile(join(dir, 'readme.md'), 'not a binary');
    await writeFile(join(dir, 'linux.so'), Buffer.from('\x7fELF', 'binary'));
    await symlink(join(dir, 'pty.node'), join(dir, 'alias.node'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds Mach-O files by content at any depth, ignoring others', async () => {
    const found = await findMachOBinaries(dir);
    assert.deepEqual(
      found.map((p) => relative(dir, p)),
      [join('nested', 'deep', 'spawn-helper'), 'pty.node'],
    );
  });

  it('does not follow symlinks', async () => {
    const found = await findMachOBinaries(dir);
    assert.equal(
      found.some((p) => p.endsWith('alias.node')),
      false,
    );
  });
});

describe('against a real system binary', { skip: process.platform !== 'darwin' }, () => {
  it('detects /bin/ls as Mach-O', async () => {
    const found = await findMachOBinaries('/bin');
    assert.equal(found.includes('/bin/ls'), true);
  });
});
