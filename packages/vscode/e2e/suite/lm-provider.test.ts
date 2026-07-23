import * as assert from 'node:assert';
import * as vscode from 'vscode';

/**
 * End-to-end test of the Language Model Chat Provider chain:
 *
 *   user picks a Gezel model in Copilot Chat
 *      → extension's `provideLanguageModelChatResponse`
 *      → SDK `app.chat({model: 'gezel:<id>', ...})`
 *      → daemon `POST /v1/chat/completions` with `model: 'gezel:<id>'`
 *      → daemon resolves to the gezel's underlying provider (MockProvider here)
 *      → response streams back to the user as `LanguageModelTextPart`
 *
 * Mock provider is deterministic ("Mock reply: <prompt>"), so the
 * assertion is straightforward.
 *
 * VS Code requires us to consent to using the language model in the
 * test process. The provider passes through that consent check by
 * default in the test host — but in case it does prompt, the polling
 * `waitFor` lets the suite ride it out.
 */

async function waitFor<T>(
  description: string,
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value !== undefined && value !== null && value !== false) {
      return value as T;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

suite('Gezel LM Chat Provider — chat round trip', () => {
  test('sendRequest against a Gezel model returns the mock provider response', async () => {
    const models = await waitFor('at least one Gezel model', async () => {
      const found = await vscode.lm.selectChatModels({ vendor: 'gezel' });
      return found.length > 0 ? found : undefined;
    });
    const model = models[0];
    if (!model) throw new Error('expected at least one Gezel model');

    const messages = [vscode.LanguageModelChatMessage.User('hello from e2e')];

    const response = await model.sendRequest(
      messages,
      {},
      new vscode.CancellationTokenSource().token,
    );

    let aggregated = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        aggregated += part.value;
      }
    }

    assert.ok(aggregated.length > 0, 'expected non-empty model response');
    // MockProvider echoes "Mock reply: <prompt>". The route's gezel:
    // resolution wraps the gezel's persona around the prompt, so the
    // user message text appears somewhere in the reply.
    assert.ok(
      aggregated.toLowerCase().includes('hello from e2e'),
      `expected model output to contain the user prompt; got: ${aggregated.slice(0, 200)}`,
    );
  });
});
