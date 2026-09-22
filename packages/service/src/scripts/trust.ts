/**
 * Whether a script's bytes are provably first-party.
 *
 * The shipped stdlib always is. A project script is, when its full content
 * equals a provenance header plus the catalog-shipped body it names, byte
 * for byte, at the exact version — or when a task's CLI-authorised hash list
 * names it. Trusted scripts may run where `denyNet` has no OS boundary under
 * the remaining sandbox layers; any edit, even whitespace, drops a script
 * back to the fail-closed path. A model cannot grant trust by editing a
 * script or supplying an invocation argument.
 */
import { createHash } from 'node:crypto';
import type { ScriptRunTrigger, ScriptScope } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';

export interface ScriptTrustInput {
  scope: ScriptScope;
  source: string;
  scriptName: string;
  inline: boolean;
  projectId: string;
  trigger: ScriptRunTrigger;
}

export interface ScriptTrust {
  provenanceTrusted: boolean;
  cliTrusted: boolean;
}

export async function computeScriptTrust(
  deps: { catalog?: CatalogService; readTask: Store['readTask'] },
  input: ScriptTrustInput,
): Promise<ScriptTrust> {
  return {
    provenanceTrusted: await isProvenanceTrusted(deps.catalog, input),
    cliTrusted: await isCliTrustedSource(deps.readTask, input),
  };
}

async function isProvenanceTrusted(
  catalog: CatalogService | undefined,
  { scope, source, scriptName, inline }: ScriptTrustInput,
): Promise<boolean> {
  if (inline) return false;
  if (scope === 'standard') return true;
  if (scope !== 'project' || !catalog) return false;
  const newline = source.indexOf('\n');
  if (newline < 0) return false;
  const header = source.slice(0, newline);
  const projectType = /^\/\/ @gezel-project-type: ([a-z0-9][a-z0-9-]*)@([0-9A-Za-z.+-]+)$/.exec(
    header,
  );
  if (projectType) {
    const detail = await catalog
      .get('project-type', projectType[1]!, undefined, projectType[2]!)
      .catch(() => null);
    if (!detail || detail.manifest.kind !== 'project-type') return false;
    const body = (detail.manifest.scripts as Record<string, string> | undefined)?.[scriptName];
    return typeof body === 'string' && source === `${header}\n${body}`;
  }
  // A craftbook's `test.json` may ship cli-shim scripts; an installed copy
  // that byte-matches the shim at the named book@version is first-party too.
  const testShim = /^\/\/ @gezel-craftbook-test: ([a-z0-9][a-z0-9-]*)@([0-9A-Za-z.+-]+)$/.exec(
    header,
  );
  if (testShim && typeof catalog.getCraftbookTestSpec === 'function') {
    const found = await catalog.getCraftbookTestSpec(testShim[1]!, testShim[2]!).catch(() => null);
    if (!found) return false;
    for (const mock of found.spec.mocks) {
      if (mock.kind !== 'cli') continue;
      if (source === `${header}\n${mock.shim.content}`) return true;
    }
    return false;
  }
  return false;
}

async function isCliTrustedSource(
  readTask: Store['readTask'],
  { scope, source, inline, projectId, trigger }: ScriptTrustInput,
): Promise<boolean> {
  if (scope !== 'craftbook' || trigger.kind !== 'step' || !inline) return false;
  const [taskProject, num] = trigger.taskRef.split('/');
  if (taskProject !== projectId || !num || !/^\d+$/.test(num)) return false;
  const task = await readTask(projectId, Number(num));
  return (
    task?.cliTrustedScriptHashes?.includes(createHash('sha256').update(source).digest('hex')) ===
    true
  );
}
