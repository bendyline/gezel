/**
 * Compile Gezel's custom NSIS include against electron-builder's pinned NSIS
 * templates on every supported host. electron-builder ships makensis binaries
 * for macOS and Linux as well as Windows, so parser errors, callback clashes,
 * and warnings promoted by `-WX` do not need a Windows release runner. Its
 * pinned macOS binary is currently x86_64-only, however, so an arm64 Mac
 * without Rosetta cannot execute it and skips this contract explicitly.
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
    // The script is written to a child that may already be gone: makensis
    // closes stdin the moment it rejects its arguments, and a failed exec
    // never opens it at all. That write races the `error`/`close` events, so
    // an unhandled EPIPE here surfaced INSTEAD of makensis's own diagnostics —
    // turning every early exit into an opaque `write EPIPE` stack. Swallow it
    // and let the exit code plus stderr below say what actually went wrong.
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });

  assert.equal(
    result.code,
    0,
    `makensis failed for ${basename(output)}:\n${result.stdout}\n${result.stderr}`,
  );
}

function isMissingRosettaSpawnError(error) {
  return (
    process.platform === 'darwin' &&
    process.arch === 'arm64' &&
    typeof error === 'object' &&
    error !== null &&
    error.errno === -86 &&
    error.syscall === 'spawn'
  );
}

/**
 * Whether this host can actually execute the makensis electron-builder ships.
 *
 * electron-builder publishes macOS/Linux/Windows makensis binaries for **x64
 * only**. On an arm64 Linux host (a DGX Spark workstation, an arm64 CI runner)
 * the exec simply fails, which is a property of the toolchain rather than of
 * Gezel's NSIS include — so the contract is unverifiable here, not violated.
 * Probing beats an `arch === 'x64'` check because it also passes on arm64 hosts
 * that do have qemu-user/binfmt wired up.
 */
async function makensisRunsOnThisHost(makensis) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(makensis.path, ['-VERSION'], {
        env: { ...process.env, ...(makensis.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => out.push(chunk));
    child.on('error', (err) => resolve({ ok: false, detail: err.message }));
    child.on('close', () => {
      // Keyed on the version string, not on exec success or exit code, because
      // neither is trustworthy here. `execvp` falls back to /bin/sh when
      // `execve` returns ENOEXEC, so a foreign-arch binary is handed to the
      // shell, which chokes on the ELF bytes and exits non-zero — no `error`
      // event is ever emitted. That looked exactly like a compile failure.
      // A real makensis answers `-VERSION` with e.g. `v3.0.4.1`; nothing else
      // does, so a match means the toolchain genuinely ran.
      const detail = Buffer.concat(out).toString('utf8').trim();
      resolve({ ok: /^v?\d+\.\d+/.test(detail), detail: detail.split('\n')[0] ?? '' });
    });
  });
}

test('custom NSIS hooks compile in electron-builder uninstaller and installer passes', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'gezel-nsis-contract-'));
  try {
    const [makensis, pluginsDir] = await Promise.all([
      getMakeNsisPath(null, null),
      getNsisPluginsPath(null, null),
    ]);

    const probe = await makensisRunsOnThisHost(makensis);
    // On x64 the shipped binary is supposed to run, so a failed probe there is
    // a real breakage (bad download, missing exec bit) and must fail loudly.
    // This keeps the skip unreachable on CI's ubuntu-latest x64 runners — the
    // contract can never quietly stop being enforced where it matters.
    if (!probe.ok && process.arch !== 'x64') {
      // Not a pass. CI runs this on ubuntu-latest (x64), which is where the
      // contract is actually enforced; skipping keeps an arm64 workstation
      // from reporting a toolchain gap as a Gezel regression. The probe output
      // is included so a genuinely broken makensis is still diagnosable rather
      // than quietly vanishing from the suite.
      t.skip(
        `electron-builder ships makensis for x64 only and it did not run on ${process.platform}/${process.arch} — needs an x64 host or qemu-user/binfmt. Probe said: ${probe.detail || '(no output)'}`,
      );
      return;
    }

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

    try {
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
    } catch (error) {
      if (isMissingRosettaSpawnError(error)) {
        t.skip("electron-builder's macOS makensis is x86_64 and Rosetta is unavailable");
        return;
      }
      throw error;
    }
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
