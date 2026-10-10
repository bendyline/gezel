import { repoRoot } from '../native-bin.ts';
import { captureQualificationIdentity } from '../qualification/metadata.ts';
import { hash } from './plan.ts';

export async function campaignIdentity() {
  const identity = await captureQualificationIdentity(repoRoot());
  if (identity.unavailable.length)
    throw new Error(`Cannot freeze campaign: ${identity.unavailable.join(', ')}`);
  const environment = Object.entries(process.env)
    .filter(([key]) => key.startsWith('GEZEL_') && !key.startsWith('GEZEL_DEPENDENCY_LEASE_'))
    .sort(([a], [b]) => a.localeCompare(b));
  return { ...identity, environmentHash: hash(environment) };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function comparable(component: string, value: unknown): unknown {
  const source = record(value);
  // Older diff-based identities cannot be migrated without their original bytes.
  if (
    component === 'source' &&
    source.algorithm === 'worktree-content-v1' &&
    typeof source.sha256 === 'string'
  )
    return { algorithm: source.algorithm, sha256: source.sha256 };
  return value ?? null;
}

export function identityChanges(before: unknown, after: unknown) {
  const a = record(before);
  const b = record(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((component) => {
    if (hash(comparable(component, a[component])) === hash(comparable(component, b[component])))
      return [];
    const oldManifest = record(a[component]).manifest;
    const newManifest = record(b[component]).manifest;
    const oldFiles = record(oldManifest);
    const newFiles = record(newManifest);
    // Without both manifests, a legacy hash can identify only the component.
    const paths =
      oldManifest && newManifest
        ? [...new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])]
            .sort()
            .filter((path) => oldFiles[path] !== newFiles[path])
        : [];
    return [{ component, paths }];
  });
}

export function describeIdentityChanges(changes: ReturnType<typeof identityChanges>) {
  return changes
    .map(({ component, paths }) => {
      const names = paths.slice(0, 8).map((path) => JSON.stringify(path));
      if (paths.length > names.length) names.push(`and ${paths.length - names.length} more`);
      return names.length ? `${component}: ${names.join(', ')}` : component;
    })
    .join('; ');
}
