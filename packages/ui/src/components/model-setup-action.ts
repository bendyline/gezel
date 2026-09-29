/**
 * Where a "no usable model" chat error should send the person.
 *
 * With nothing installed, the one-click setup on Home is the whole answer:
 * it offers the recommended download directly. Otherwise the fix is on the
 * engine's own models page. The error names its engine by prefix ("Local
 * model:", "Apple MLX:"), the convention every on-device provider error uses.
 */
export type ModelSetupTarget = { kind: 'home' } | { kind: 'settings'; section: string };

export interface ModelSetupAction {
  label: string;
  target: ModelSetupTarget;
}

export function modelSetupAction(error: string): ModelSetupAction | null {
  if (/no (chat )?model is installed/i.test(error)) {
    return { label: 'Set up a model', target: { kind: 'home' } };
  }
  if (!/Settings/.test(error)) return null;
  if (error.startsWith('Apple MLX:')) {
    return { label: 'Choose a model', target: { kind: 'settings', section: 'mlx' } };
  }
  if (error.startsWith('Local model:')) {
    return { label: 'Choose a model', target: { kind: 'settings', section: 'llamaCpp' } };
  }
  if (error.includes('Settings → Artificial Intelligence')) {
    return { label: 'Choose a model', target: { kind: 'settings', section: 'defaults' } };
  }
  return null;
}
