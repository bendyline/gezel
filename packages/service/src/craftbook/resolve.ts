import type { Craftbook, CraftbookTemplateManifest } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import { readBundledCraftbookScripts } from '../scripts/install.js';
import type { CraftbookResolver } from '../tasks/manager.js';

/**
 * Map a resolved catalog craftbook-template manifest into the runtime
 * `Craftbook` shape. One mapping for every consumer (task resolver,
 * craftbook routes, project-type install) so a field added to the
 * template schema can't ride into one snapshot and silently miss another.
 */
export function runtimeCraftbookFromTemplate(
  m: CraftbookTemplateManifest,
  about: string | undefined,
  scripts: Record<string, string> | undefined,
): Craftbook {
  return {
    id: m.id,
    name: m.name,
    ...(about ? { description: about } : m.description ? { description: m.description } : {}),
    version: m.version,
    ...(m.basedOn ? { basedOn: m.basedOn } : {}),
    ...(m.plan ? { plan: m.plan } : {}),
    ...(m.defaultAssignee ? { defaultAssignee: m.defaultAssignee } : {}),
    steps: m.steps,
    entryStepId: m.entryStepId,
    // triggers / hooks come from the catalog version manifest and need to
    // ride into embedded snapshots — the chat session reads
    // `task.craftbook.hooks` to install the bridge hook list, and the
    // workspace skill-discovery + commands UI surfaces triggers for
    // slash-command-style invocation. Without this they go dark.
    ...(m.triggers ? { triggers: m.triggers } : {}),
    ...(m.hooks ? { hooks: m.hooks } : {}),
    // toolsets ride in too: the chat session derives its auto-allow tool
    // set from `task.craftbook.toolsets`, and the launcher reads them to
    // offer install/config before invoking.
    ...(m.toolsets ? { toolsets: m.toolsets } : {}),
    ...(m.paramSchema ? { paramSchema: m.paramSchema } : {}),
    ...(m.command ? { command: m.command } : {}),
    ...(m.requirements ? { requirements: m.requirements } : {}),
    ...(m.runModes ? { runModes: m.runModes } : {}),
    ...(scripts ? { scripts } : {}),
    // Declarative per-item fanout config rides into the runtime book so the
    // task snapshot carries it — the runtime reads `task.craftbook.spawn`
    // at fanout time (see the onStepActivated fanout branch in service.ts).
    ...(m.spawn ? { spawn: m.spawn } : {}),
    createdAt: m.releasedAt,
    updatedAt: m.releasedAt,
  };
}

/**
 * The craftbook resolution chain: project-local books (workspace
 * `.gezel/craftbooks/`, often auto-imported from a SKILL.md) shadow
 * local templates, which shadow the bundled catalog. Extracted from the
 * service boot wiring so the project-type install path resolves through
 * the exact same chain the TaskManager uses.
 */
export function makeCraftbookResolver(store: Store, catalog: CatalogService): CraftbookResolver {
  return {
    async resolve(id, opts) {
      if (opts?.projectId) {
        const project = await store
          .getProjectCraftbook(opts.projectId, id, opts?.version)
          .catch(() => null);
        if (project) {
          return {
            craftbook: project,
            sourceId: 'project',
            ...(project.version ? { version: project.version } : {}),
          };
        }
      }
      const local = await store.getLocalCraftbookTemplate(id, opts?.version).catch(() => null);
      if (local) {
        return {
          craftbook: local,
          sourceId: 'local',
          ...(local.version ? { version: local.version } : {}),
        };
      }
      // Positional fix over the historical inline wiring: `CatalogService.get`
      // takes (kind, id, sourceId, version) — passing the version third made
      // version-pinned bundled lookups miss every source.
      const detail = await catalog
        .get('craftbook-template', id, undefined, opts?.version)
        .catch(() => null);
      if (!detail || detail.manifest.kind !== 'craftbook-template') return null;
      const m = detail.manifest;
      // Hydrate bundled script files into the inline `scripts` map so
      // embedded snapshots carry their own sources — gate/lifecycle scripts
      // run from the snapshot; the project-install copy is the legacy
      // fallback.
      const scripts = await readBundledCraftbookScripts(catalog, m).catch(() => undefined);
      return {
        craftbook: runtimeCraftbookFromTemplate(m, detail.about, scripts),
        sourceId: detail.sourceId,
        version: m.version,
      };
    },
  };
}
