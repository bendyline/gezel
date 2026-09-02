import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function repositoryFile(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

const windowsHost = repositoryFile('../../../native/helpers/service-host/src/main.cpp');
const windowsInstaller = repositoryFile('../installer/nsis-hooks.nsh');
const macLaunchDaemon = repositoryFile('../installer/com.bendyline.gezeld.plist');
const linuxSystemd = repositoryFile('../installer/gezeld.service');
const signingPolicy = repositoryFile('../scripts/third-party-binaries.cjs');
const electronBuilderConfig = repositoryFile('../electron-builder.yml');
const releaseWorkflow = repositoryFile('../../../.github/workflows/release-electron.yml');

describe('bundled pnpm runtime contract', () => {
  it('uses the ordinary pnpm JavaScript entrypoint on Windows', () => {
    expect(windowsHost).toContain('dist\\\\pnpm-bundle\\\\bin\\\\pnpm.mjs');
    expect(windowsHost).toContain('dist\\\\node-bundle\\\\node.exe');
    expect(windowsHost).not.toContain('dist\\\\pnpm-bundle\\\\pnpm.exe');
  });

  it('exercises the installed Windows service in the release job', () => {
    const packageStep = releaseWorkflow.indexOf('- name: Package Windows installer');
    const installStep = releaseWorkflow.indexOf('- name: Smoke-test packaged Windows installer');
    const appStep = releaseWorkflow.indexOf('- name: Smoke-test installed Windows app');

    expect(packageStep).toBeGreaterThanOrEqual(0);
    expect(packageStep).toBeLessThan(installStep);
    expect(installStep).toBeLessThan(appStep);
    expect(releaseWorkflow).toContain("-ArgumentList '/S' -Wait -PassThru");
    expect(releaseWorkflow).toContain('Get-Service -Name GezelService -ErrorAction Stop');
    expect(releaseWorkflow).toContain('MachineServiceInstalled');
    expect(releaseWorkflow).toContain('https://127.0.0.1:$port/api/health');
    expect(releaseWorkflow).toContain("$health.serviceRole -ne 'machine-engine'");
    expect(releaseWorkflow).toContain('- name: Uninstall Windows installer smoke');
    expect(windowsInstaller).toContain(
      '$INSTDIR\\resources\\app.asar.unpacked\\dist\\node-bundle\\node.exe',
    );
  });

  it('uses the ordinary pnpm JavaScript entrypoint on macOS', () => {
    expect(macLaunchDaemon).toContain('/dist/pnpm-bundle/bin/pnpm.mjs</string>');
    expect(macLaunchDaemon).toContain('/dist/node-bundle/node</string>');
    expect(macLaunchDaemon).not.toContain('/dist/pnpm-bundle/pnpm</string>');
  });

  it('uses the ordinary pnpm JavaScript entrypoint on Linux', () => {
    expect(linuxSystemd).toContain('/dist/pnpm-bundle/bin/pnpm.mjs');
    expect(linuxSystemd).toContain('/dist/node-bundle/node');
    expect(linuxSystemd).not.toContain('/dist/pnpm-bundle/pnpm\n');
  });

  it('never signs a pnpm standalone executable and verifies bundled Node as OpenJS', () => {
    expect(signingPolicy).not.toContain("pattern: '^pnpm\\\\.exe$'");
    expect(signingPolicy).toContain('dist/pnpm-bundle/');
    expect(signingPolicy).toContain('fastlist-[\\\\w.-]+\\\\.exe$');

    const nodeCheck = releaseWorkflow.indexOf("$executable.Name -ieq 'node.exe'");
    const thirdPartySkip = releaseWorkflow.indexOf('Test-ThirdParty $executable.FullName');
    expect(nodeCheck).toBeGreaterThanOrEqual(0);
    expect(nodeCheck).toBeLessThan(thirdPartySkip);
    expect(releaseWorkflow).toContain('O=OpenJS Foundation');
  });

  it('preserves and verifies the upstream macOS Node executable', () => {
    expect(electronBuilderConfig).toContain(
      '- /Contents/Resources/app\\.asar\\.unpacked/dist/node-bundle/node$',
    );
    expect(releaseWorkflow).toContain('shasum -a 256 -c sha256.txt');
    expect(releaseWorkflow).toContain(
      'codesign --verify --strict --check-notarization --verbose=2 "$node_bundle/node"',
    );
    expect(releaseWorkflow).toContain('TeamIdentifier=HX7739G8FX');
  });
});
