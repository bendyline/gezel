import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Resolve a Chromium executable downloaded into Gezel's managed Playwright
 * directory.
 *
 * The browser revision installed by the system Playwright toolset can differ
 * from a library caller's `playwright-core` revision. Returning the executable
 * explicitly avoids Playwright's revision-specific default path while still
 * requiring its installation-complete marker.
 */
export async function resolveManagedChromiumBinary(browsersDir: string): Promise<string | null> {
  if (!existsSync(browsersDir)) return null;

  let entries: string[];
  try {
    entries = await readdir(browsersDir);
  } catch {
    return null;
  }

  const roots = entries
    .filter((entry) => entry.startsWith('chromium-'))
    .sort()
    .reverse()
    .map((entry) => join(browsersDir, entry))
    .filter((root) => existsSync(join(root, 'INSTALLATION_COMPLETE')));

  for (const root of roots) {
    for (const candidate of chromiumBinaryCandidates(root)) {
      if (existsSync(candidate)) return candidate;
    }
  }

  const headlessRoots = entries
    .filter((entry) => entry.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse()
    .map((entry) => join(browsersDir, entry))
    .filter((root) => existsSync(join(root, 'INSTALLATION_COMPLETE')));

  for (const root of headlessRoots) {
    for (const candidate of headlessShellBinaryCandidates(root)) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function chromiumBinaryCandidates(root: string): string[] {
  switch (process.platform) {
    case 'darwin':
      return ['chrome-mac-arm64', 'chrome-mac'].flatMap((dir) => [
        join(
          root,
          dir,
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
        join(root, dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ]);
    case 'win32':
      return ['chrome-win64', 'chrome-win'].map((dir) => join(root, dir, 'chrome.exe'));
    case 'linux':
      return ['chrome-linux64', 'chrome-linux'].map((dir) => join(root, dir, 'chrome'));
    default:
      return [];
  }
}

function headlessShellBinaryCandidates(root: string): string[] {
  switch (process.platform) {
    case 'darwin':
      return ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac'].map((dir) =>
        join(root, dir, 'chrome-headless-shell'),
      );
    case 'win32':
      return ['chrome-headless-shell-win64', 'chrome-headless-shell-win'].flatMap((dir) => [
        join(root, dir, 'chrome-headless-shell.exe'),
        join(root, dir, 'headless_shell.exe'),
      ]);
    case 'linux':
      return ['chrome-headless-shell-linux64', 'chrome-headless-shell-linux'].map((dir) =>
        join(root, dir, 'chrome-headless-shell'),
      );
    default:
      return [];
  }
}
