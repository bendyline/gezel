import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  findMachOBinaries,
  isDistributionReadyDeveloperIdSignature,
  isMachOMagic,
} from './sign-macho-tree.mjs';

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

describe('isDistributionReadyDeveloperIdSignature', () => {
  const valid = [
    'Executable=/tmp/node',
    'Identifier=node',
    'CodeDirectory v=20500 size=937904 flags=0x10000(runtime) hashes=29299+7 location=embedded',
    'Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)',
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'Timestamp=Jun 23, 2026 at 6:43:00 AM',
    'TeamIdentifier=HX7739G8FX',
    'Runtime Version=15.0.0',
  ].join('\n');

  it('accepts a timestamped, hardened Developer ID signature with an Apple trust chain', () => {
    assert.equal(isDistributionReadyDeveloperIdSignature(valid), true);
  });

  it('rejects ad-hoc signatures without a team or authorities', () => {
    const adHoc = [
      'Identifier=uv-8d713fe443e45729',
      'CodeDirectory v=20400 size=123 flags=0x20002(adhoc,linker-signed) hashes=3+0',
      'TeamIdentifier=not set',
    ].join('\n');
    assert.equal(isDistributionReadyDeveloperIdSignature(adHoc), false);
  });

  it('rejects Developer ID signatures missing a notarization prerequisite', () => {
    const cases = [
      valid.replace('flags=0x10000(runtime)', 'flags=0x0(none)'),
      valid.replace(/^Timestamp=.+\n/m, ''),
      valid.replace('TeamIdentifier=HX7739G8FX', 'TeamIdentifier=not set'),
      valid.replace('Authority=Developer ID Certification Authority\n', ''),
      valid.replace('Authority=Apple Root CA\n', ''),
    ];
    for (const details of cases) {
      assert.equal(isDistributionReadyDeveloperIdSignature(details), false);
    }
  });
});

describe('against a real system binary', { skip: process.platform !== 'darwin' }, () => {
  it('detects /bin/ls as Mach-O', async () => {
    const found = await findMachOBinaries('/bin');
    assert.equal(found.includes('/bin/ls'), true);
  });
});
