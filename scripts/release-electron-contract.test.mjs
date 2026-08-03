import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('Electron release configuration pins the audited packaging contracts', async () => {
  const [
    builder,
    workflow,
    tsup,
    main,
    stamp,
    corePackage,
    lockfile,
    frontmatter,
    metainfo,
    installerVerifier,
    appPackage,
    rootPackage,
    readme,
    nativeWorkflow,
  ] = await Promise.all([
    readFile(join(root, 'packages', 'app', 'electron-builder.yml'), 'utf8'),
    readFile(join(root, '.github', 'workflows', 'release-electron.yml'), 'utf8'),
    readFile(join(root, 'packages', 'app', 'tsup.config.ts'), 'utf8'),
    readFile(join(root, 'packages', 'app', 'src', 'main.ts'), 'utf8'),
    readFile(join(root, 'scripts', 'stamp-version.mjs'), 'utf8'),
    readFile(join(root, 'packages', 'core', 'package.json'), 'utf8'),
    readFile(join(root, 'pnpm-lock.yaml'), 'utf8'),
    readFile(join(root, 'packages', 'core', 'src', 'markdown', 'frontmatter.ts'), 'utf8'),
    readFile(join(root, 'packages', 'app', 'assets', 'com.bendyline.gezel.metainfo.xml'), 'utf8'),
    readFile(join(root, 'scripts', 'verify-installer-licenses.mjs'), 'utf8'),
    readFile(join(root, 'packages', 'app', 'package.json'), 'utf8'),
    readFile(join(root, 'package.json'), 'utf8'),
    readFile(join(root, 'README.md'), 'utf8'),
    readFile(join(root, '.github', 'workflows', 'build-native.yml'), 'utf8'),
  ]);

  assert.match(tsup, /noExternal:/);
  assert.match(tsup, /@bendyline\\\/gezel-client/);
  assert.match(tsup, /dist\/main\.js still contains a runtime import/);
  assert.match(tsup, /__gezelCreateRequire/);
  assert.doesNotMatch(corePackage, /gray-matter/);
  assert.doesNotMatch(lockfile, /gray-matter/);
  assert.match(corePackage, /"yaml": "\^2\.9\.0"/);
  assert.doesNotMatch(frontmatter, /node:fs|from ['"]fs/);

  assert.match(main, /GEZEL_PACKAGED_SMOKE/);
  assert.match(main, /apiClient\.health\(\)/);
  assert.match(main, /webContents\.executeJavaScript/);
  assert.match(main, /bundled Node runtime did not pass integrity verification and install/);
  assert.match(main, /bundled pnpm runtime did not pass integrity verification and install/);
  assert.equal(
    workflow.match(/- name: Smoke-test packaged (?:Windows|macOS|Linux) app/g)?.length,
    3,
    'every packaged desktop platform must execute its final unpacked app',
  );
  const windowsSmokeStart = workflow.indexOf('- name: Smoke-test packaged Windows app');
  const windowsSmokeEnd = workflow.indexOf('- name: Verify Windows signatures', windowsSmokeStart);
  const windowsSmoke = workflow.slice(windowsSmokeStart, windowsSmokeEnd);
  assert.match(windowsSmoke, /WaitForExit\(360000\)/);
  assert.match(windowsSmoke, /RedirectStandardOutput/);
  assert.match(windowsSmoke, /RedirectStandardError/);
  assert.match(windowsSmoke, /Get-Content -LiteralPath \$path -Tail 400/);
  assert.match(windowsSmoke, /timed out after 360 seconds/);
  assert.ok(
    (workflow.match(/180(?:s| seconds)/g)?.length ?? 0) >= 2,
    'macOS and Linux packaged smoke tests must have bounded timeouts',
  );
  const linuxSmokeStart = workflow.indexOf('- name: Smoke-test packaged Linux app');
  const linuxSmokeEnd = workflow.indexOf(
    '- name: Verify Linux installer legal payloads',
    linuxSmokeStart,
  );
  const linuxSmoke = workflow.slice(linuxSmokeStart, linuxSmokeEnd);
  assert.match(linuxSmoke, /sudo apt-get install -y/);
  assert.match(linuxSmoke, /executable=\/opt\/Gezel\/gezel/);
  assert.doesNotMatch(
    linuxSmoke,
    /--no-sandbox/,
    'the Linux release smoke must exercise Chromium sandbox startup',
  );

  assert.match(builder, /minimumSystemVersion: '13\.5'/);
  assert.match(builder, /- target: pkg[\s\S]*?- target: zip/);
  const pkgSectionStart = builder.indexOf('\npkg:');
  const pkgSectionEnd = builder.indexOf('\n# ── Linux', pkgSectionStart);
  assert.notEqual(pkgSectionStart, -1, 'electron-builder must define macOS PKG options');
  assert.notEqual(pkgSectionEnd, -1, 'macOS PKG options must remain a distinct config section');
  const pkgSection = builder.slice(pkgSectionStart, pkgSectionEnd);
  assert.match(
    pkgSection,
    /^\s{2}isRelocatable: false$/m,
    'the system-service PKG must always install Gezel.app at /Applications',
  );
  assert.match(workflow, /latest-mac\.yml/);
  assert.match(workflow, /packages\/app\/dist\/installers\/\*\.zip\.blockmap/);
  assert.equal(
    workflow.match(
      /\$extensions = node packages\/app\/scripts\/third-party-binaries\.cjs --extensions \| ConvertFrom-Json/g,
    )?.length,
    2,
    'both Windows signature gates must consume the shared loadable-extension policy',
  );
  assert.match(workflow, /\$extensions -contains \$_.Extension\.ToLowerInvariant\(\)/);

  assert.equal(
    builder.match(
      /assets\/com\.bendyline\.gezel\.metainfo\.xml=\/usr\/share\/metainfo\/com\.bendyline\.gezel\.metainfo\.xml/g,
    )?.length,
    2,
    'both deb and rpm packages must install Gezel AppStream metadata',
  );
  assert.match(metainfo, /<id>\s*com\.bendyline\.gezel\s*<\/id>/);
  assert.match(metainfo, /<metadata_license>\s*MIT\s*<\/metadata_license>/);
  assert.match(metainfo, /<project_license>\s*MIT\s*<\/project_license>/);
  assert.match(metainfo, /<launchable\s+type="desktop-id">\s*gezel\.desktop\s*<\/launchable>/);
  assert.match(installerVerifier, /verifyLinuxAppStreamMetadata/);
  assert.match(installerVerifier, /declares the MIT project license in AppStream metadata/);
  assert.match(
    workflow,
    /appstreamcli validate packages\/app\/assets\/com\.bendyline\.gezel\.metainfo\.xml/,
  );

  const productTagline = 'Your crew of AI companions';
  const productDescription =
    'Build a crew of named AI companions with distinct roles and tools, then put them to work on your projects. Gezel stores their conversations, memory, and work on your computer as ordinary files.';
  assert.ok(builder.includes(`synopsis: ${productTagline}`));
  assert.ok(builder.includes(`description: ${productDescription}`));
  assert.ok(metainfo.includes(`<summary>${productTagline}</summary>`));
  assert.equal(JSON.parse(rootPackage).description, productDescription);
  // packages/app is the deliberate exception: electron-builder stamps its
  // description into the NSIS installer's FileDescription, which Windows shows
  // as the UAC "Program name". Marketing copy there titles the elevation prompt
  // with a paragraph, so that field tracks productName instead — asserted by
  // scripts/windows-branding-contract.test.mjs.
  assert.notEqual(
    JSON.parse(appPackage).description,
    productDescription,
    'packages/app description is the Windows UAC program name, not marketing copy',
  );
  assert.match(
    readme,
    /Gezel helps you build a crew of named AI companions with distinct roles and tools/,
  );

  const rpmSection = builder.slice(builder.indexOf('\nrpm:'), builder.length);
  assert.match(rpmSection, /^\s{4}- gtk3$/m);
  assert.doesNotMatch(rpmSection, /^\s+- libgtk-3-0$/m);
  assert.match(workflow, /rpm -qpR/);

  assert.match(stamp, /packages\/core\/src\/index\.ts/);
  assert.equal(
    workflow.match(/node scripts\/verify-release-version\.mjs/g)?.length,
    4,
    'quality plus every platform build must verify release-version propagation',
  );

  assert.match(workflow, /mkdir -p release-assets/);
  assert.match(workflow, /release asset basename collision/);
  assert.doesNotMatch(workflow, /artifacts\/flat/);
  assert.doesNotMatch(workflow, /find artifacts .* -exec ln/);

  const nativeReleaseStart = nativeWorkflow.indexOf('- name: Create draft Release');
  assert.notEqual(nativeReleaseStart, -1, 'native workflow must create a distinct release');
  const nativeRelease = nativeWorkflow.slice(nativeReleaseStart);
  assert.match(
    nativeRelease,
    /^\s+prerelease: true$/m,
    'native-v* releases must not replace the Electron app at /releases/latest',
  );
  assert.match(
    nativeRelease,
    /^\s+make_latest: false$/m,
    'prerelease alone is editable at publish time; make_latest is the flag the API consults',
  );

  // A native release in the stable channel makes the updater find no release at
  // all, which is silent from the release side. Both halves must fail closed.
  assert.match(
    workflow,
    /Native release \$\{NATIVE_TAG\} is not marked as a prerelease/,
    'preflight must reject a native release that could take /releases/latest',
  );
  assert.match(
    workflow,
    /releases\/latest currently resolves to/,
    'preflight must reject a repository whose /releases/latest is not an app tag',
  );
  assert.match(
    workflow,
    /check-latest-release-namespace\.mjs/,
    'the release must hand the operator a post-publish update-discovery check',
  );
});

test('macOS release installs the finished PKG and exercises recovery', async () => {
  const workflow = await readFile(
    join(root, '.github', 'workflows', 'release-electron.yml'),
    'utf8',
  );
  const macPkgSmokeStart = workflow.indexOf('- name: Smoke-test macOS PKG install and recovery');
  const macPkgSmokeEnd = workflow.indexOf(
    '- name: Verify macOS update metadata was generated',
    macPkgSmokeStart,
  );
  assert.notEqual(macPkgSmokeStart, -1, 'macOS release must install the finished PKG');
  const macPkgSmoke = workflow.slice(macPkgSmokeStart, macPkgSmokeEnd);
  assert.equal(
    macPkgSmoke.match(/install_pkg "/g)?.length,
    3,
    'macOS PKG smoke must cover clean install, reinstall, and disabled-state recovery',
  );
  assert.equal(
    macPkgSmoke.match(/sudo \/usr\/sbin\/installer -pkg "\$pkg" -target \//g)?.length,
    1,
    'every macOS PKG install must go through the diagnostic wrapper',
  );
  assert.match(macPkgSmoke, /sudo tail -n 400 \/var\/log\/install\.log/);
  assert.match(macPkgSmoke, /process == "package_script_service"/);
  assert.match(macPkgSmoke, /sudo dscl \. -read \/Users\/_gezeld/);
  assert.match(macPkgSmoke, /launchctl disable "system\/\$daemon_label"/);
  assert.match(macPkgSmoke, /assert_installed_health/);
  assert.match(macPkgSmoke, /--cacert "\$runtime_dir\/cert\.pem"/);
  assert.match(macPkgSmoke, /trap cleanup EXIT/);
});
