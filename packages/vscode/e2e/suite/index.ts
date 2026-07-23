import { resolve } from 'node:path';
import { glob } from 'glob';
import Mocha from 'mocha';

/**
 * Mocha bootstrapper. Loaded by VS Code via `extensionTestsPath` after
 * the extension host has started — at this point `vscode.workspace`,
 * `vscode.commands`, etc. are all live and tests can import `vscode`
 * directly.
 *
 * Globs every `*.test.cjs` next to this file and runs them in serial
 * (parallel test files inside one VS Code instance race on the same
 * daemon, output channel, and consent flow).
 */
export async function run(): Promise<void> {
  const mocha = new Mocha({
    // TDD interface (suite/test) — the convention VS Code's own
    // extension-test docs use. BDD (describe/it) would need every
    // test file converted; TDD matches what's already written.
    ui: 'tdd',
    color: true,
    timeout: 60_000,
  });

  const testsRoot = resolve(__dirname);
  const files = await glob('**/*.test.cjs', { cwd: testsRoot });
  for (const file of files) {
    mocha.addFile(resolve(testsRoot, file));
  }

  return new Promise<void>((resolveRun, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed`));
        } else {
          resolveRun();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
