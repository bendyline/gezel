import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLibreOfficeSetupManager } from './manager.js';

let home: string;
let oxt: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-lo-'));
  oxt = join(home, 'gezel.oxt');
  await writeFile(oxt, 'oxt-v1');
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const installed = async () => ({
  sofficePath: '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  unopkgPath: '/Applications/LibreOffice.app/Contents/MacOS/unopkg',
  version: '25.8.1.1',
});

describe('libreoffice setup manager', () => {
  it('walks not-configured → waiting for the desktop app → configured', async () => {
    const m = createLibreOfficeSetupManager({ home, oxtPath: () => oxt, detect: installed });
    const initial = await m.status();
    expect(initial.state).toBe('not-configured');
    expect(initial.canConfigure).toBe(true);
    expect(initial.extensionId).toBe('com.bendyline.gezel');

    const pending = await m.configure();
    expect(pending.state).toBe('update-needed');
    expect(pending.installed).toBeNull();

    const done = await m.recordHostReport({ installed: true });
    expect(done.state).toBe('configured');
    expect(done.reportedAt).toBeDefined();
  });

  it('offers the update when a newer .oxt ships', async () => {
    const m = createLibreOfficeSetupManager({ home, oxtPath: () => oxt, detect: installed });
    await m.configure();
    await m.recordHostReport({ installed: true });
    await writeFile(oxt, 'oxt-v2');
    const status = await m.status();
    expect(status.state).toBe('update-needed');
    expect(status.reasons.join(' ')).toMatch(/newer/);
    // Installing reports this build's extension, which clears the reason.
    expect((await m.recordHostReport({ installed: true })).state).toBe('configured');
  });

  it('surfaces a failed install with its error', async () => {
    const m = createLibreOfficeSetupManager({ home, oxtPath: () => oxt, detect: installed });
    await m.configure();
    const status = await m.recordHostReport({
      installed: false,
      error: 'Close LibreOffice first.',
    });
    expect(status.state).toBe('update-needed');
    expect(status.reasons[0]).toContain('Close LibreOffice first.');
  });

  it('is unavailable without LibreOffice or without the bundled extension', async () => {
    const noLo = createLibreOfficeSetupManager({
      home,
      oxtPath: () => oxt,
      detect: async () => ({}),
    });
    expect((await noLo.status()).state).toBe('unavailable');
    expect((await noLo.status()).canConfigure).toBe(false);

    const noOxt = createLibreOfficeSetupManager({
      home,
      oxtPath: () => undefined,
      detect: installed,
    });
    expect((await noOxt.status()).state).toBe('unavailable');
    await expect(noOxt.configure()).rejects.toMatchObject({
      code: 'libreoffice_extension_missing',
    });
  });

  it('removes its record', async () => {
    const m = createLibreOfficeSetupManager({ home, oxtPath: () => oxt, detect: installed });
    await m.configure();
    expect((await m.remove()).state).toBe('not-configured');
  });
});
