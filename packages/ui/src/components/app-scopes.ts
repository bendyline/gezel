/**
 * What each app scope lets an app do, in the words the consent prompt and
 * the Connected list use. An unknown scope (from a newer daemon) shows as
 * its name rather than disappearing.
 */
const APP_SCOPE_DESCRIPTIONS: Record<string, string> = {
  openai: 'Chat with the models Gezel runs',
  knowledge: 'Search the knowledge installed in Gezel',
  images:
    'Generate images on this computer, which uses graphics memory and disk space for image models',
  'remote-inference': 'Run models this computer serves',
  product: 'Read and change your gezellen, projects, settings, models, and conversations',
  cli: 'Control Gezel from the command line',
};

export function describeAppScope(scope: string): string {
  return APP_SCOPE_DESCRIPTIONS[scope] ?? scope;
}

/** Scopes a grant asks for that the app does not hold yet; all of them for a new connection. */
export function addedAppScopes(grant: { scopes: string[]; upgradeFrom?: string[] }): string[] {
  const held = new Set(grant.upgradeFrom ?? []);
  return grant.scopes.filter((scope) => !held.has(scope));
}
