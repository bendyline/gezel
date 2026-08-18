import * as assert from 'node:assert';
import * as vscode from 'vscode';

/**
 * Smoke tests that the extension activates cleanly and registers
 * every surface a user touches: commands, the chat webview view, and
 * the Language Model Chat Provider.
 *
 * Each test waits for the underlying state to stabilize using a small
 * polling helper — the extension activates ASYNC (daemon spawn, SDK
 * consent flow, LM provider registration), so a hard assertion at
 * suite start would race the activation lifecycle.
 */

// The extension id VS Code computes is `<publisher>.<name>` — and
// `name` in our package.json is the scoped `@bendyline/gezel-vscode`,
// so the literal id is `bendyline.@bendyline/gezel-vscode`. Matches
// what activation crashes show ("Activating extension
// 'bendyline.@bendyline/gezel-vscode' failed…").
const EXTENSION_ID = 'bendyline.@bendyline/gezel-vscode';
const ACTIVATION_TIMEOUT_MS = 30_000;

async function waitFor<T>(
  description: string,
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number = ACTIVATION_TIMEOUT_MS,
  intervalMs = 250,
): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value !== undefined && value !== null && value !== false) {
        return value as T;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for: ${description}${lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ''}`,
  );
}

suite('Gezel extension — activation', () => {
  test('the extension is installed under the expected id', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found — check package.json publisher/name`);
  });

  test('activate() resolves without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('every contributed command is registered with VS Code', async () => {
    const expected = [
      'gezel.openChat',
      'gezel.switchGezel',
      'gezel.switchFolder',
      'gezel.refresh',
      'gezel.showLogs',
    ];
    const all = await vscode.commands.getCommands(true);
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `command ${cmd} is not registered`);
    }
  });

  test('the Gezel Language Model Chat Provider registers and surfaces at least one model', async () => {
    // The LM provider registration happens AFTER the daemon resolves
    // AND the SDK consent flow completes. With `GEZEL_AUTOAPPROVE_APPS=vscode`
    // set in the runner, that's ~1–10 seconds; we poll up to the
    // suite-wide timeout to ride out cold-boot variance.
    const models = await waitFor(
      'vscode.lm.selectChatModels({vendor: gezel}) → non-empty',
      async () => {
        const found = await vscode.lm.selectChatModels({ vendor: 'gezel' });
        return found.length > 0 ? found : undefined;
      },
    );
    assert.ok(models.length > 0, 'no Gezel models registered with vscode.lm');
    // Every entry's id MUST be `gezel:<role>-<name>` — that's how the
    // route routes the chat call back through the right gezel.
    for (const m of models) {
      assert.ok(
        m.id.startsWith('gezel:'),
        `expected model id to start with "gezel:", got "${m.id}"`,
      );
      assert.ok(
        m.name.startsWith('Gezel: '),
        `expected model name to start with "Gezel: ", got "${m.name}"`,
      );
    }
  });

  test('the chat webview view is contributed (visible in the activity bar)', async () => {
    // VS Code doesn't expose a direct query for registered webview
    // views, but `focus`-ing the view through its command will throw
    // if the view container isn't registered. This catches the
    // common regression of dropping the `viewsContainers` /
    // `views.gezel[].webview` block from package.json.
    await vscode.commands.executeCommand('gezel.chat.focus');
  });
});
