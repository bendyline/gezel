/**
 * The small identity slice needed to expose a gezel as a model in another app.
 */
export interface ExternalGezelModelIdentity {
  id: string;
  name: string;
  role?: string;
}

/**
 * Build the human-readable model id advertised to external apps.
 *
 * Roles and names are intentionally kept as separate slug components so a
 * Developer named Sipho becomes `gezel:developer-sipho`. The persisted gezel
 * id remains the last-resort component for names that contain no ASCII
 * letters or digits. Callers should continue accepting `gezel:<persisted-id>`
 * as a legacy/stable alias even though it is no longer the advertised value.
 */
export function externalGezelModelId(gezel: ExternalGezelModelIdentity): string {
  const role = externalModelSlug(gezel.role ?? '');
  const name = externalModelSlug(gezel.name) || externalModelSlug(gezel.id) || 'gezel';
  return `gezel:${role ? `${role}-${name}` : name}`;
}

function externalModelSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
