import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageScriptsEdit, resolveSecurityPolicy } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

/**
 * The `allowPackageScriptEdits` backstop for scripts gezels write.
 * `run_nodejs_script` and `derive_file` hold write access to the whole
 * workspace through Node's permission model, so their manifest edits never
 * pass the Store's check. Snapshot the root manifests before the run and put
 * back any scripts change the policy does not allow afterwards.
 *
 * Root only: that is what `run_package_script` and the person's own
 * `npm test` read. A nested workspace package's manifest is not covered.
 */
const ROOT_MANIFESTS = ['package.json', 'package.json5', 'package.yaml'] as const;

export type RootManifestSnapshot = ReadonlyMap<string, string | null>;

export async function snapshotRootManifests(workspaceDir: string): Promise<RootManifestSnapshot> {
  const snapshot = new Map<string, string | null>();
  for (const name of ROOT_MANIFESTS) {
    snapshot.set(name, await readFile(join(workspaceDir, name), 'utf8').catch(() => null));
  }
  return snapshot;
}

/** Restore every root manifest whose scripts changed against policy; a note for the run's output, or null. */
export async function restoreGatedManifestEdits(
  store: Store,
  workspaceDir: string,
  snapshot: RootManifestSnapshot,
): Promise<string | null> {
  const restored: string[] = [];
  for (const [name, before] of snapshot) {
    const full = join(workspaceDir, name);
    const after = await readFile(full, 'utf8').catch(() => null);
    if (packageScriptsEdit(name, before, after).kind === 'unchanged') continue;
    if (resolveSecurityPolicy(await store.readConfig()).allowPackageScriptEdits) return null;
    if (before === null) await rm(full, { force: true });
    else await writeFile(full, before, 'utf8');
    restored.push(name);
  }
  if (restored.length === 0) return null;
  return `[gezel] Put back ${restored.join(', ')}: the script added or changed package scripts, and "Edit package scripts" is off in Settings → Security & Compliance. Leave package scripts as they are.`;
}
