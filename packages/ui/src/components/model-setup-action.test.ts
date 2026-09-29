import { describe, expect, it } from 'vitest';
import { modelSetupAction } from './model-setup-action.js';

describe('modelSetupAction', () => {
  it('sends a person with no model back to the one-click setup on Home', () => {
    expect(
      modelSetupAction(
        'Local model: no model is installed yet. Download one from Settings → Artificial Intelligence, then try again.',
      ),
    ).toEqual({ label: 'Set up a model', target: { kind: 'home' } });
    expect(
      modelSetupAction(
        'No chat model is installed on this device. Download or import one in Settings → Artificial Intelligence.',
      )?.target,
    ).toEqual({ kind: 'home' });
  });

  it("opens the engine's own models page when models exist", () => {
    expect(
      modelSetupAction(
        'Local model: the selected model "qwen" is no longer available. Pick a local model in Settings → This PC.',
      )?.target,
    ).toEqual({ kind: 'settings', section: 'llamaCpp' });
    expect(
      modelSetupAction(
        'Apple MLX: the selected model is no longer available. Pick one in Settings.',
      )?.target,
    ).toEqual({ kind: 'settings', section: 'mlx' });
  });

  it('offers nothing for unrelated errors', () => {
    expect(modelSetupAction('The request timed out.')).toBeNull();
  });
});
