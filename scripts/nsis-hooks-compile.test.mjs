/**
 * Compile Gezel's custom NSIS include against electron-builder's pinned NSIS
 * templates on every host. electron-builder ships native makensis binaries
 * for macOS and Linux as well as Windows, so parser errors, callback clashes,
 * and warnings promoted by `-WX` do not need a Windows release runner.
 *
 * electron-builder compiles NSIS twice: first with BUILD_UNINSTALLER to
 * produce the embedded uninstaller, then again for the final installer. Keep
 * both passes here; installer-only functions leaking into the first pass are
 * exactly the kind of error this contract is intended to catch.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const appDir = join(root, 'packages', 'app');
const appRequire = createRequire(join(appDir, 'package.json'));
const builderRequire = createRequire(appRequire.resolve('electron-builder/package.json'));

const { getMakeNsisPath, getNsisPluginsPath } = builderRequire(
  'app-builder-lib/out/toolsets/windows',
);
const { LangConfigurator, addCustomMessageFileInclude, createAddLangsMacro } = builderRequire(
  'app-builder-lib/out/targets/nsis/nsisLang',
);
const { NsisScriptGenerator } = builderRequire(
  'app-builder-lib/out/targets/nsis/nsisScriptGenerator',
);
const { UninstallerReader, nsisTemplatesDir } = builderRequire(
  'app-builder-lib/out/targets/nsis/nsisUtil',
);

async function compileNsis({ makensis, script, defines, output }) {
  const args = ['-WX', '-INPUTCHARSET', 'UTF8'];
  for (const [name, value] of Object.entries(defines)) {
    args.push(value == null ? `-D${name}` : `-D${name}=${value}`);
  }
  args.push('-XUnicode true', `-XOutFile "${output}"`, '-');

  const result = await new Promise((resolve, reject) => {
    const child = spawn(makensis.path, args, {
      cwd: nsisTemplatesDir,
      env: { ...process.env, ...(makensis.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(script);
  });

  assert.equal(
    result.code,
    0,
    `makensis failed for ${basename(output)}:\n${result.stdout}\n${result.stderr}`,
  );
}

test('custom NSIS hooks compile in electron-builder uninstaller and installer passes', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'gezel-nsis-contract-'));
  try {
    const [makensis, pluginsDir] = await Promise.all([
      getMakeNsisPath(null, null),
      getNsisPluginsPath(null, null),
    ]);

    const messagesDir = join(workDir, 'messages');
    const vcRedistDir = join(workDir, 'dist', 'vc-redist');
    await Promise.all([
      mkdir(messagesDir, { recursive: true }),
      mkdir(vcRedistDir, { recursive: true }),
    ]);

    let tempFileIndex = 0;
    const packagerStub = {
      getTempFile(name) {
        tempFileIndex += 1;
        return join(messagesDir, `${tempFileIndex}-${name}`);
      },
    };
    const languages = new LangConfigurator({
      installerLanguages: ['en_US'],
      multiLanguageInstaller: false,
      unicode: true,
    });
    const header = new NsisScriptGenerator();
    header.include(join(nsisTemplatesDir, 'include', 'StdUtils.nsh'));
    header.addIncludeDir(join(nsisTemplatesDir, 'include'));
    header.flags([
      'updated',
      'force-run',
      'keep-shortcuts',
      'no-desktop-shortcut',
      'delete-app-data',
      'allusers',
      'currentuser',
    ]);
    createAddLangsMacro(header, languages);
    header.addPluginDir('x86-unicode', join(pluginsDir, 'x86-unicode'));
    await addCustomMessageFileInclude('messages.yml', packagerStub, header, languages);
    await addCustomMessageFileInclude('assistedMessages.yml', packagerStub, header, languages);
    header.macro('licensePage', [`!insertmacro MUI_PAGE_LICENSE "${join(appDir, 'EULA.txt')}"`]);
    header.addIncludeDir(join(appDir, 'assets'));
    header.include(join(appDir, 'installer', 'nsis-hooks.nsh'));

    const template = await readFile(join(nsisTemplatesDir, 'installer.nsi'), 'utf8');
    const script = header.build() + template;
    const archive = join(workDir, 'app-x64.nsis.7z');
    const intermediate = join(workDir, 'uninstaller-generator.exe');
    const uninstaller = join(workDir, 'uninstaller.exe');
    const installer = join(workDir, 'installer.exe');
    await Promise.all([
      writeFile(archive, 'compile-only application archive'),
      writeFile(join(vcRedistDir, 'vc_redist.x64.exe'), 'compile-only VC redistributable'),
    ]);

    const defines = {
      APP_ID: 'com.bendyline.gezel',
      APP_GUID: 'ae0eab93-8860-5107-b103-523c834d0ece',
      UNINSTALL_APP_KEY: 'ae0eab93-8860-5107-b103-523c834d0ece',
      PRODUCT_NAME: 'Gezel',
      PRODUCT_FILENAME: 'gezel',
      APP_FILENAME: 'gezel',
      APP_DESCRIPTION: 'Gezel',
      VERSION: '1.0.0',
      PROJECT_DIR: workDir,
      BUILD_RESOURCES_DIR: join(appDir, 'assets'),
      APP_PACKAGE_NAME: '@bendyline\\gezel-app',
      UNINSTALL_URL_HELP: 'https://github.com/bendyline/gezel',
      UNINSTALL_URL_INFO_ABOUT: 'https://github.com/bendyline/gezel',
      UNINSTALL_URL_UPDATE_INFO: 'https://github.com/bendyline/gezel',
      UNINSTALL_URL_README: 'https://github.com/bendyline/gezel',
      MUI_ICON: join(appDir, 'assets', 'icon.ico'),
      MUI_UNICON: join(appDir, 'assets', 'icon.ico'),
      APP_64: archive,
      APP_64_NAME: basename(archive),
      APP_64_HASH: '0'.repeat(128),
      APP_64_UNPACKED_SIZE: '1',
      COMPANY_NAME: 'Bendyline LLC',
      APP_INSTALLER_STORE_FILE: '@bendylinegezel-app-updater\\installer.exe',
      COMPRESSION_METHOD: '7z',
      MULTIUSER_INSTALLMODE_ALLOW_ELEVATION: null,
      INSTALL_MODE_PER_ALL_USERS: null,
      INSTALL_MODE_PER_ALL_USERS_REQUIRED: null,
      SHORTCUT_NAME: 'Gezel',
      UNINSTALL_DISPLAY_NAME: 'Gezel 1.0.0',
      MUI_WELCOMEFINISHPAGE_BITMAP: join(appDir, 'assets', 'installerSidebar.bmp'),
      UNINSTALLER_ICON: join(appDir, 'assets', 'icon.ico'),
      MUI_UNWELCOMEFINISHPAGE_BITMAP: join(appDir, 'assets', 'uninstallerSidebar.bmp'),
      ESTIMATED_SIZE: '1',
      COMPRESS: 'auto',
    };

    await compileNsis({
      makensis,
      script,
      defines: {
        ...defines,
        BUILD_UNINSTALLER: null,
        UNINSTALLER_OUT_FILE: uninstaller,
      },
      output: intermediate,
    });
    await UninstallerReader.exec(intermediate, uninstaller);
    await compileNsis({
      makensis,
      script,
      defines: {
        ...defines,
        UNINSTALLER_OUT_FILE: uninstaller,
      },
      output: installer,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
