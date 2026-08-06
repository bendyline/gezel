import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function repositoryFile(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

const packageMetadata = JSON.parse(repositoryFile('../package.json')) as Record<string, unknown>;
const electronBuilderConfig = repositoryFile('../electron-builder.yml');
const mainProcess = repositoryFile('./main.ts');
const devDesktopInstaller = repositoryFile('../scripts/install-dev-desktop.mjs');

describe('Linux desktop branding contract', () => {
  it('gives Electron a polished product name and stable desktop identity', () => {
    expect(packageMetadata.productName).toBe('Gezel');
    expect(packageMetadata.desktopName).toBe('com.bendyline.gezel.desktop');
  });

  it('keeps the packaged desktop entry, window identity, and icon associated', () => {
    expect(electronBuilderConfig).toMatch(/linux:\n(?: {2}.*\n)*? {2}syncDesktopName: true\n/);
    expect(electronBuilderConfig).toMatch(/linux:\n[\s\S]*? {2}icon: assets\/icon\.png\n/);
    expect(mainProcess).toContain(
      "const linuxDesktopId = app.isPackaged ? 'com.bendyline.gezel' : 'com.bendyline.gezel.dev';",
    );
    expect(mainProcess).toContain('app.setDesktopName(`${linuxDesktopId}.desktop`)');
    expect(mainProcess).toContain("app.commandLine.appendSwitch('class', linuxDesktopId)");
  });

  it('uses a matching, separate desktop identity for development launches', () => {
    expect(devDesktopInstaller).toContain("const desktopId = 'com.bendyline.gezel.dev';");
    expect(devDesktopInstaller).toContain('StartupWMClass=${desktopId}');
    expect(devDesktopInstaller).toContain('`${desktopId}.desktop`');
  });
});
