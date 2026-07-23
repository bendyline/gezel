import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Outer e2e entry point. Boots VS Code via `@vscode/test-electron`,
 * tells it to load OUR extension (`extensionDevelopmentPath`), then
 * runs the Mocha bootstrap at `extensionTestsPath`. The bootstrap
 * loads every compiled `dist-e2e/suite/*.test.cjs` file.
 *
 * Each run isolates state in a tmp directory:
 *   - `GEZEL_HOME`    — fresh `~/.gezel` so the daemon spawns a clean
 *                       runtime/, tokens.json, etc.
 *   - `GEZEL_AUTOAPPROVE_APPS=vscode` — the SDK consent flow auto-
 *                       approves the `vscode` app so the LM provider
 *                       can register without a UI prompt.
 *   - `GEZEL_MOCK_PROVIDER=1` — every LLM call routes to MockProvider
 *                       so tests are deterministic and offline.
 *
 * The same env block is what you'd set on `Run Extension (e2e)` in
 * launch.json — the harness mirrors how a human would test the
 * extension by hand.
 */
async function main(): Promise<void> {
  // Hosts that run Electron-based tools (Claude Code, some IDEs) set
  // ELECTRON_RUN_AS_NODE=1 in the global shell so they can invoke
  // their own binaries as plain Node. Inherited into our launch,
  // it makes the VS Code executable run as Node and reject every
  // VS Code option ("bad option: --user-data-dir", "Cannot find
  // module <workspace>"). Strip it before spawning.
  delete process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_NO_ATTACH_CONSOLE;

  const extensionDevelopmentPath = resolve(__dirname, '..');
  const extensionTestsPath = resolve(__dirname, 'suite', 'index.cjs');

  const gezelHome = mkdtempSync(join(tmpdir(), 'gezel-e2e-home-'));
  const workspaceFolder = mkdtempSync(join(tmpdir(), 'gezel-e2e-ws-'));

  // VS Code's downloaded test instance gets its own profile too —
  // keeps the user's settings/extensions out of the picture.
  const userDataDir = mkdtempSync(join(tmpdir(), 'gezel-e2e-vscode-'));

  // eslint-disable-next-line no-console
  console.log(`[e2e] gezelHome=${gezelHome}`);
  // eslint-disable-next-line no-console
  console.log(`[e2e] workspaceFolder=${workspaceFolder}`);

  let exitCode = 0;
  try {
    await runTests({
      // Pin to a VS Code minor that we know matches our @types/vscode
      // (1.118.x). The launcher Code.exe on more recent builds (1.122+)
      // rejects every `--option` we pass — `bin\code.cmd` is the real
      // CLI on Windows post-1.122 and @vscode/test-electron@2.5 doesn't
      // resolve it correctly. Fall back to a known-good version.
      version: '1.97.2',
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        // Options FIRST. A bare positional arg gets interpreted by
        // Electron as a Node entry point and the test instance dies
        // with "Cannot find module <path>" before the extension host
        // even boots. Pass the workspace via --folder-uri instead.
        //
        // `--user-data-dir VAL` (space-separated) errors with
        // "bad option" on Windows VS Code stable; the `=` form works.
        `--user-data-dir=${userDataDir}`,
        '--disable-extensions',
        `--folder-uri=${workspaceFolderToUri(workspaceFolder)}`,
      ],
      extensionTestsEnv: {
        ...process.env,
        GEZEL_HOME: gezelHome,
        GEZEL_AUTOAPPROVE_APPS: 'vscode',
        GEZEL_MOCK_PROVIDER: '1',
        // Plain HTTP loopback — the extension test host's fetch
        // doesn't know about the per-launch self-signed cert. The
        // daemon falls back to HTTP/1.1 with this flag.
        GEZEL_INSECURE_TRANSPORT: '1',
        GEZEL_E2E: '1',
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[e2e] failed:', err);
    exitCode = 1;
  } finally {
    rmSync(gezelHome, { recursive: true, force: true });
    rmSync(workspaceFolder, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

function workspaceFolderToUri(folder: string): string {
  // file:// URI on Windows needs a leading slash before the drive
  // letter and forward slashes throughout. Standard Node has no
  // built-in helper, so this is manual.
  const normalized = folder.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

void main();
