import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { auditPeTree, findPeBinaries, isPeImage, verifyPeTree } from './verify-pe-tree.mjs';

const require = createRequire(import.meta.url);
const {
  isThirdPartyBinary,
  isWindowsLoadableBinary,
  thirdPartyMetadata,
} = require('../packages/app/scripts/third-party-binaries.cjs');

/**
 * Minimal well-formed PE header: `MZ`, an e_lfanew at 0x3c pointing at a
 * `PE\0\0` signature. Enough for content-based detection, which is all this
 * module does with the bytes.
 */
function peImage({ peOffset = 0x80 } = {}) {
  const buf = Buffer.alloc(Math.max(0x200, peOffset + 4));
  buf.write('MZ', 0, 'binary');
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32BE(0x50450000, peOffset);
  return buf;
}

describe('isPeImage', () => {
  it('accepts a well-formed PE header', () => {
    assert.equal(isPeImage(peImage()), true);
  });

  it('rejects Mach-O, ELF, text, and short reads', () => {
    const machO = Buffer.alloc(0x200);
    machO.writeUInt32BE(0xfeedfacf, 0);
    assert.equal(isPeImage(machO), false);

    const elf = Buffer.alloc(0x200);
    elf.write('\x7fELF', 0, 'binary');
    assert.equal(isPeImage(elf), false);

    assert.equal(isPeImage(Buffer.alloc(0x200)), false);
    assert.equal(isPeImage(Buffer.alloc(0x10)), false);
    assert.equal(isPeImage(null), false);
  });

  it('rejects a DOS stub that never reaches a PE signature', () => {
    // Starts with MZ but e_lfanew points at zeroes — a real DOS executable,
    // or any file that merely happens to begin "MZ".
    const dos = Buffer.alloc(0x200);
    dos.write('MZ', 0, 'binary');
    dos.writeUInt32LE(0x80, 0x3c);
    assert.equal(isPeImage(dos), false);
  });

  it('rejects an e_lfanew pointing past the bytes we read', () => {
    const buf = Buffer.alloc(0x200);
    buf.write('MZ', 0, 'binary');
    buf.writeUInt32LE(0xffffff00, 0x3c);
    assert.equal(isPeImage(buf), false);
  });
});

describe('findPeBinaries', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-pe-'));
    await mkdir(join(dir, 'node_modules', 'node-pty', 'prebuilds'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'node-pty', 'prebuilds', 'pty.node'), peImage());
    // No extension — the case an extension allowlist would miss.
    await writeFile(join(dir, 'helper'), peImage());
    await writeFile(join(dir, 'index.js'), 'module.exports = {};');
    await writeFile(join(dir, 'readme.md'), 'not a binary');
    try {
      await symlink(join(dir, 'helper'), join(dir, 'helper-link'));
    } catch {
      /* symlink creation needs privilege on Windows; the case below is skipped */
    }
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds PE images by content, at any depth, ignoring non-binaries', async () => {
    const found = await findPeBinaries(dir);
    assert.equal(found.length, 2);
    assert.ok(found.some((p) => p.endsWith('pty.node')));
    assert.ok(found.some((p) => p.endsWith('helper')));
    assert.ok(!found.some((p) => p.endsWith('.js') || p.endsWith('.md')));
  });

  it('does not follow symlinks', async () => {
    const found = await findPeBinaries(dir);
    assert.ok(!found.some((p) => p.endsWith('helper-link')));
  });
});

describe('auditPeTree', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-pe-audit-'));
    await writeFile(join(dir, 'gezel-thing.dll'), peImage());
    await writeFile(join(dir, 'pty.node'), peImage());
    await writeFile(join(dir, 'vec0.dll'), peImage());
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('partitions into signed, allowlisted, and unaccounted-for', async () => {
    const result = await auditPeTree(dir, {
      checkSigned: (file) => file.endsWith('gezel-thing.dll'),
    });
    assert.equal(result.binaries, 3);
    assert.deepEqual(result.signed, ['gezel-thing.dll']);
    assert.deepEqual(result.exempt.map((e) => e.file).sort(), ['pty.node', 'vec0.dll']);
    assert.deepEqual(result.unsigned, []);
  });

  it('reports a valid signature as signed even when the file is allowlisted', async () => {
    // node-pty's ConPTY helpers arrive Microsoft-signed. The log must say so
    // rather than crediting the allowlist for a signature that exists.
    const result = await auditPeTree(dir, { checkSigned: () => true });
    assert.equal(result.signed.length, 3);
    assert.deepEqual(result.exempt, []);
  });

  it('flags an unsigned binary that nobody vouched for', async () => {
    const result = await auditPeTree(dir, { checkSigned: () => false });
    assert.deepEqual(result.unsigned, ['gezel-thing.dll']);
  });
});

describe('third-party allowlist covers prebuilt Windows payloads', () => {
  // The eight prebuilt binaries observed unsigned inside
  // service-bundle.tar.gz for win32-x64. If a bundled package renames one,
  // verify-pe-tree fails the release; this fails first, and says why.
  const bundled = [
    'resvgjs.win32-x64-msvc.node',
    'keyring.win32-x64-msvc.node',
    'vec0.dll',
    'pty.node',
    'conpty.node',
    'conpty_console_list.node',
    'winpty.dll',
    'winpty-agent.exe',
  ];

  for (const name of bundled) {
    it(`exempts ${name}`, () => {
      assert.equal(isThirdPartyBinary(`C:\\bundle\\node_modules\\pkg\\${name}`), true);
    });
  }

  it('still refuses a first-party binary', () => {
    assert.equal(isThirdPartyBinary('C:\\bundle\\gezel-llama-server.exe'), false);
    assert.equal(isThirdPartyBinary('C:\\bundle\\gezel-service-host.exe'), false);
  });

  it('does not exempt a lookalike that merely contains an allowlisted name', () => {
    // Patterns are anchored, so a first-party file cannot borrow the
    // exemption by embedding a vendor name.
    assert.equal(isThirdPartyBinary('C:\\bundle\\not-vec0.dll'), false);
    assert.equal(isThirdPartyBinary('C:\\bundle\\pty.node.exe'), false);
  });

  it('classifies native Node addons as loadable binaries that must be audited', () => {
    for (const name of ['tool.exe', 'library.dll', 'addon.node']) {
      assert.equal(isWindowsLoadableBinary(name), true);
    }
    assert.equal(isWindowsLoadableBinary('addon.node.map'), false);
    assert.equal(isWindowsLoadableBinary('README.md'), false);
  });
});

describe('verifyPeTree', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-pe-verify-'));
    await writeFile(join(dir, 'pty.node'), peImage());
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('no-ops off Windows', async () => {
    assert.equal(await verifyPeTree(dir, { platform: 'darwin' }), null);
    assert.equal(await verifyPeTree(dir, { platform: 'linux' }), null);
  });

  it('treats an empty tree as a bad root, not a clean pass', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'gezel-pe-empty-'));
    try {
      await assert.rejects(
        () => verifyPeTree(empty, { platform: 'win32', env: {} }),
        /no PE binaries found/,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
