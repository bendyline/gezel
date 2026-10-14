import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { libreOfficeVersion, windowsExecutableVersion } from './detect.js';

/** A version resource's fixed block, product version 26.8.1.1, amid other bytes. */
function executableBytes(): Buffer {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x0001_0000, 4);
  fixed.writeUInt32LE((26 << 16) | 8, 8); // file version: the same
  fixed.writeUInt32LE((1 << 16) | 1, 12);
  fixed.writeUInt32LE((26 << 16) | 8, 16); // product version
  fixed.writeUInt32LE((1 << 16) | 1, 20);
  // A stray signature with the wrong structure version must not be taken.
  const decoy = Buffer.from([0xbd, 0x04, 0xef, 0xfe, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300), decoy, Buffer.alloc(40), fixed]);
}

describe('LibreOffice version on Windows', () => {
  it("reads the executable's own version resource", () => {
    expect(windowsExecutableVersion(executableBytes())).toBe('26.8.1.1');
    expect(windowsExecutableVersion(Buffer.from('not an executable'))).toBeUndefined();
  });

  it('reads the file instead of starting LibreOffice', async () => {
    // Running `soffice.exe --version` left a windowless soffice.bin holding
    // the profile, and the extension's install then refused with "Close
    // LibreOffice first". A file that cannot run proves nothing was spawned.
    const dir = await mkdtemp(join(tmpdir(), 'gezel-lo-version-'));
    try {
      const soffice = join(dir, 'soffice.exe');
      await writeFile(soffice, executableBytes());
      expect(await libreOfficeVersion(soffice, 'win32')).toBe('26.8.1.1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const installed = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
  it.skipIf(process.platform !== 'win32' || !existsSync(installed))(
    'reads an installed LibreOffice',
    async () => {
      expect(await libreOfficeVersion(installed, 'win32')).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    },
  );
});
