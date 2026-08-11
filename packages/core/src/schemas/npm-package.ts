import { z } from 'zod';

const NPM_NAME_SEGMENT = /^[a-z0-9](?:[a-z0-9._~-]*[a-z0-9])?$/;
const SEMVER_NUMBER = String.raw`(?:0|[1-9]\d*)`;
const SEMVER_PART = String.raw`(?:${SEMVER_NUMBER}|[xX*])`;
const SEMVER_CORE = String.raw`${SEMVER_PART}(?:\.${SEMVER_PART}){0,2}`;
const SEMVER_IDENTIFIER = String.raw`[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*`;
const SEMVER_SUFFIX = String.raw`(?:-${SEMVER_IDENTIFIER})?(?:\+${SEMVER_IDENTIFIER})?`;
const SEMVER_ATOM = new RegExp(String.raw`^(?:\^|~|>=|<=|>|<|=)?v?${SEMVER_CORE}${SEMVER_SUFFIX}$`);
const SEMVER_HYPHEN_RANGE = new RegExp(
  String.raw`^v?${SEMVER_CORE}${SEMVER_SUFFIX}\s+-\s+v?${SEMVER_CORE}${SEMVER_SUFFIX}$`,
);
const DIST_TAG = /^[a-z][a-z0-9._-]{0,127}$/;

export function isValidNpmPackageName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 214) return false;
  if (value !== value.trim() || value !== value.toLowerCase()) return false;
  if (value.startsWith('@')) {
    const parts = value.slice(1).split('/');
    return (
      parts.length === 2 &&
      parts[0] !== undefined &&
      parts[1] !== undefined &&
      NPM_NAME_SEGMENT.test(parts[0]) &&
      NPM_NAME_SEGMENT.test(parts[1])
    );
  }
  return !value.includes('/') && NPM_NAME_SEGMENT.test(value);
}

/**
 * Registry-only npm version selector. Supports dist-tags and controlled
 * semver/range forms while rejecting URLs, Git refs, aliases, local paths,
 * workspace protocols, and option-like strings.
 */
export function isValidNpmRegistryVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  if (value !== value.trim()) return false;
  if (DIST_TAG.test(value) || SEMVER_HYPHEN_RANGE.test(value)) return true;
  const alternatives = value.split('||');
  if (alternatives.some((part) => part.trim().length === 0)) return false;
  return alternatives.every((alternative) => {
    const atoms = alternative.trim().split(/\s+/);
    return atoms.length > 0 && atoms.every((atom) => SEMVER_ATOM.test(atom));
  });
}

export const NpmPackageNameSchema = z.string().refine(isValidNpmPackageName, {
  message: 'must be a lowercase npm registry package name (for example zod or @types/node)',
});

export const NpmRegistryVersionSchema = z.string().refine(isValidNpmRegistryVersion, {
  message: 'must be a registry dist-tag or semver range',
});

export const NpmRegistryPackageRequestSchema = z
  .object({
    package: NpmPackageNameSchema,
    version: NpmRegistryVersionSchema.optional(),
  })
  .strict();
export type NpmRegistryPackageRequest = z.infer<typeof NpmRegistryPackageRequestSchema>;

export function formatNpmRegistrySpec(name: string, version?: string): string {
  const packageName = NpmPackageNameSchema.parse(name);
  if (version === undefined) return packageName;
  return `${packageName}@${NpmRegistryVersionSchema.parse(version)}`;
}
