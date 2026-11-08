import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function repositoryFile(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

const withoutComments = (text: string, marker: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(marker))
    .join('\n');

const electronBuilderConfig = withoutComments(repositoryFile('../electron-builder.yml'), '#');
const nsisHooks = withoutComments(repositoryFile('../installer/nsis-hooks.nsh'), ';');
const mainProcess = repositoryFile('./main.ts');
const preload = repositoryFile('./preload.cjs');

// Each platform gets `gezel://` from a different place, and a missing one
// fails silently: the browser asks to open Gezel and nothing happens.
describe('gezel:// link registration contract', () => {
  it('declares the scheme for macOS, Linux and the store packages', () => {
    expect(electronBuilderConfig).toMatch(
      /^protocols:\n {2}- name: .+\n {4}schemes:\n {6}- gezel$/m,
    );
  });

  it('registers per user on Windows, where NSIS writes no protocol keys, and removes it on uninstall', () => {
    expect(mainProcess).toContain('app.setAsDefaultProtocolClient(GEZEL_URL_SCHEME);');
    expect(nsisHooks).toContain('DeleteRegKey HKCU "Software\\Classes\\gezel"');
  });

  it('takes links from macOS open-url and from both command lines', () => {
    expect(mainProcess).toContain("app.on('open-url'");
    expect(mainProcess).toContain('findDeepLinkArguments(commandLine)');
    expect(mainProcess).toContain('findDeepLinkArguments(process.argv)');
  });

  it('buffers a link in preload until the app subscribes', () => {
    expect(mainProcess).toContain("webContents.send('gezel:deep-link'");
    expect(preload).toContain("ipcRenderer.on('gezel:deep-link'");
    expect(preload).toContain('onDeepLink:');
  });
});
