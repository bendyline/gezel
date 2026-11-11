/**
 * The model a hosted provider runs when neither the gezel nor the install names
 * one. Kept apart from the providers so task-strategy resolution can read it
 * without loading them: a measured strategy applies to the model that will
 * actually run (`resolveExecutionModelFor`).
 */
export const HOSTED_PROVIDER_DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  'codex-cli': 'gpt-6.1-sol',
} as const;

export function hostedProviderDefaultModel(providerName: string): string | undefined {
  return (HOSTED_PROVIDER_DEFAULT_MODELS as Readonly<Record<string, string>>)[providerName];
}
