/**
 * The Windows publisher string reaches users through two independent paths,
 * and a July 2026 audit of v1.26210.19 found them disagreeing: the Authenticode
 * certificate and app-update.yml said "Bendyline LLC" while Add/Remove Programs
 * said "Bendyline".
 *
 * They come from different config:
 *   - electron-builder.yml `win.signtoolOptions.publisherName` is what
 *     electron-updater checks the downloaded installer's signature against. It
 *     must equal the certificate CN or auto-update refuses the update.
 *   - packages/app/package.json `author.name` becomes AppInfo.companyName,
 *     which is the ARP Publisher — and the Vendor/Maintainer on .deb/.rpm.
 *
 * Nothing links them, so this does.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** The CN on the Azure Trusted Signing certificate the release workflow uses. */
const CERTIFICATE_COMMON_NAME = 'Bendyline LLC';

test('Windows publisher identity is consistent across every surface', async () => {
  const [builder, appPackage] = await Promise.all([
    readFile(join(root, 'packages', 'app', 'electron-builder.yml'), 'utf8'),
    readFile(join(root, 'packages', 'app', 'package.json'), 'utf8'),
  ]);

  const publisherName = builder.match(/^\s*publisherName:\s*'([^']+)'/m)?.[1];
  assert.equal(
    publisherName,
    CERTIFICATE_COMMON_NAME,
    'win.signtoolOptions.publisherName must equal the signing certificate CN — ' +
      'electron-updater verifies the downloaded installer against it',
  );

  const author = JSON.parse(appPackage).author?.name;
  assert.equal(
    author,
    CERTIFICATE_COMMON_NAME,
    'packages/app author.name becomes the Add/Remove Programs Publisher and the ' +
      'Linux .deb/.rpm Vendor+Maintainer; keep it equal to the certificate CN',
  );
});

test('the Windows installer uses the product name in the UAC prompt', async () => {
  const [builder, appPackage] = await Promise.all([
    readFile(join(root, 'packages', 'app', 'electron-builder.yml'), 'utf8'),
    readFile(join(root, 'packages', 'app', 'package.json'), 'utf8'),
  ]);

  const productName = builder.match(/^productName:\s*(.+)$/m)?.[1]?.trim();
  const description = JSON.parse(appPackage).description;

  // electron-builder stamps the NSIS installer's FileDescription from the
  // application package description. Windows presents FileDescription as the
  // UAC "Program name", so marketing copy here becomes a misleading title.
  assert.equal(
    description,
    productName,
    'packages/app description becomes the installer FileDescription and must ' +
      'stay equal to productName so UAC identifies the installer as Gezel',
  );
});

test('the Windows tray gives the shell the multi-resolution ICO path', async () => {
  const [traySource, icon] = await Promise.all([
    readFile(join(root, 'packages', 'app', 'src', 'tray.ts'), 'utf8'),
    readFile(join(root, 'packages', 'app', 'assets', 'icon.ico')),
  ]);

  const windowsBranch = traySource.slice(
    traySource.indexOf("if (process.platform === 'win32')"),
    traySource.indexOf('// Linux (and platform fallbacks)'),
  );
  assert.match(
    windowsBranch,
    /const ico = join\(this\.deps\.assetsDir, 'icon\.ico'\);/,
    'the Windows tray must use the pixel-aligned ICO instead of shrinking the padded app PNG',
  );
  assert.match(
    windowsBranch,
    /if \(existsSync\(ico\)\) return ico;/,
    'pass the ICO path to Tray so Windows can select a frame; createFromPath collapses it',
  );

  assert.equal(icon.readUInt16LE(0), 0, 'icon.ico must have the ICO reserved word');
  assert.equal(icon.readUInt16LE(2), 1, 'icon.ico must identify itself as an icon');
  const imageCount = icon.readUInt16LE(4);
  const sizes = Array.from({ length: imageCount }, (_, index) => {
    const offset = 6 + index * 16;
    const width = icon.readUInt8(offset) || 256;
    const height = icon.readUInt8(offset + 1) || 256;
    return `${width}x${height}`;
  });
  for (const size of ['16x16', '20x20', '24x24']) {
    assert.ok(sizes.includes(size), `icon.ico must include a ${size} tray frame`);
  }
});

test('the assisted installer and uninstaller ship Gezel sidebar art', async () => {
  const builder = await readFile(join(root, 'packages', 'app', 'electron-builder.yml'), 'utf8');
  const sidebars = {
    installerSidebar: 'assets/installerSidebar.bmp',
    uninstallerSidebar: 'assets/uninstallerSidebar.bmp',
  };

  for (const [setting, relativePath] of Object.entries(sidebars)) {
    assert.match(
      builder,
      new RegExp(`^  ${setting}: ${relativePath.replace('.', '\\.')}$`, 'm'),
      `nsis.${setting} must name Gezel's custom sidebar so electron-builder does not restore its stock artwork`,
    );

    const bitmap = await readFile(join(root, 'packages', 'app', relativePath));
    assert.equal(bitmap.toString('ascii', 0, 2), 'BM', `${relativePath} must be a BMP`);
    assert.equal(bitmap.readInt32LE(18), 164, `${relativePath} must be exactly 164px wide`);
    assert.equal(
      Math.abs(bitmap.readInt32LE(22)),
      314,
      `${relativePath} must be exactly 314px tall`,
    );
    assert.equal(bitmap.readUInt16LE(28), 24, `${relativePath} must be a 24-bit BMP`);
    assert.equal(bitmap.readUInt32LE(30), 0, `${relativePath} must be uncompressed`);
  }
});

test('the installer records InstallLocation for Add/Remove Programs', async () => {
  const hook = await readFile(join(root, 'packages', 'app', 'installer', 'nsis-hooks.nsh'), 'utf8');

  // electron-builder writes InstallLocation only under its own
  // INSTALL_REGISTRY_KEY, never into the uninstall/ARP key that Settings and
  // inventory tooling read.
  assert.match(
    hook,
    /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" InstallLocation "\$INSTDIR"/,
    'customInstall must add InstallLocation to the Add/Remove Programs key',
  );

  // registryAddInstallInfo creates that key before customInstall runs, so the
  // write has to live inside customInstall to land on an existing key — and
  // outside the service-registration flow, which bails to SkipNssm on error.
  const installBody = hook.slice(hook.indexOf('!macro customInstall'));
  const write = installBody.indexOf('InstallLocation "$INSTDIR"');
  const firstSkip = installBody.indexOf('Goto SkipNssm');
  assert.ok(write >= 0, 'InstallLocation write missing from customInstall');
  assert.ok(
    write < firstSkip,
    'InstallLocation must be recorded before any Goto SkipNssm, so a machine-service ' +
      'failure still leaves correct Add/Remove Programs metadata',
  );
});
