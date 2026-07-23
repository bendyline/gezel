/**
 * Single chokepoint for choosing between a gezel's friendly `name`
 * ("Mira") and their kebab-case `roleBasedName` ("visual-designer").
 *
 * `roleBasedNameOnlyMode` is the global config flag: when on, every UI
 * surface and every prompt substitution renders the role-based name.
 * Imported from `@bendyline/gezel` by both UI and service.
 */
export interface DisplayableGezel {
  name: string;
  roleBasedName?: string;
}

export function displayName(g: DisplayableGezel, roleBasedNameOnlyMode: boolean): string {
  if (roleBasedNameOnlyMode && g.roleBasedName && g.roleBasedName.length > 0) {
    return g.roleBasedName;
  }
  return g.name;
}
