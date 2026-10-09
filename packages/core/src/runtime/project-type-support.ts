import { craftbookTemplateManifestFromRuntime } from '../craftbook-doc.js';
import type { PortableInference } from '../mobile/inference.js';
import { classifyModelTier } from '../model-profile/local-model-tier.js';
import { type ProjectTypeHost, renderTurnStatePrelude } from '../project-types/composition.js';
import type { CatalogItemDetail, ProjectTypeTool } from '../schemas/catalog.js';
import type { Craftbook } from '../schemas/craftbook.js';
import { type MobileModelInventory, MobileProviderIdSchema } from '../schemas/mobile-provider.js';
import type { ChatSession } from '../schemas/session.js';
import type { PortableCatalogModel } from './content.js';
import type { PortableProjectTypes } from './project-types.js';
import type { PortableScripts } from './script-host.js';
import type { PortableStore } from './store.js';

/**
 * What the product service reads to serve a project's type: the craftbooks a
 * project offers, what this device offers the type's sessions, and the state
 * its script reports for a turn.
 */
export interface PortableProjectTypeSupportHost {
  store: PortableStore;
  types: PortableProjectTypes;
  inference: PortableInference;
  scripts(): PortableScripts | undefined;
  craftbooks(): readonly { item: CatalogItemDetail; book: Craftbook }[];
  /** The catalog entry of a downloaded model; an imported file has none. */
  catalogModelFor(
    inventory: MobileModelInventory | undefined,
    modelId: string,
  ): PortableCatalogModel | undefined;
}

/**
 * The activity's state as its own script reads it, for a person's message:
 * the transcript may hold older copies, or none when the last seed failed.
 */
export async function portableTurnState(
  scripts: PortableScripts | undefined,
  session: ChatSession,
  tools: readonly ProjectTypeTool[],
  stateTool: string,
): Promise<{ prelude: string; output: unknown } | null> {
  const tool = tools.find((item) => item.name === stateTool);
  if (!tool || !scripts) return null;
  try {
    const run = await scripts.run({
      projectId: session.projectId,
      scriptName: tool.script,
      scope: 'project',
      inputs: { ...(tool.bind ?? {}) },
      trigger: { kind: 'chat', gezelId: session.gezelId, sessionId: session.id },
      admission: 'wait',
    });
    return run.status === 'ok' && run.output !== undefined
      ? { prelude: renderTurnStatePrelude(tool.name, run.output), output: run.output }
      : null;
  } catch {
    return null;
  }
}

/**
 * The craftbooks a project offers: a book its type carries, then the bundled
 * catalog. As on the desktop, the books the type declares are suggested by
 * definition, under the type's name.
 */
export async function portableProjectCraftbookOffer(
  host: Pick<PortableProjectTypeSupportHost, 'store' | 'types' | 'craftbooks'>,
  projectId: string,
) {
  const project = await host.store.getProject(projectId).catch(() => null);
  const entry = await host.types.forProject(project).catch(() => undefined);
  const carried = Object.values(entry?.craftbooks ?? {}).flatMap((book) => {
    const manifest = craftbookTemplateManifestFromRuntime(book);
    return manifest ? [{ sourceId: 'project', kind: 'craftbook-template' as const, manifest }] : [];
  });
  const carriedIds = new Set(carried.map((item) => item.manifest.id));
  const items = [
    ...carried,
    ...host
      .craftbooks()
      .map((book) => book.item)
      .filter((item) => !carriedIds.has(item.manifest.id)),
  ];
  const offered = new Set(items.map((item) => item.manifest.id));
  const manifest = entry?.item.manifest;
  return {
    items,
    suggestedIds: (manifest?.craftbooks ?? []).filter((bookId) => offered.has(bookId)),
    missingToolsets: {},
    projectType: manifest ? { id: manifest.id, label: manifest.name } : null,
  };
}

/** A craftbook the project's bundled type declares, by id. */
export async function portableProjectTypeCraftbook(
  host: Pick<PortableProjectTypeSupportHost, 'store' | 'types'>,
  projectId: string | undefined,
  id: string,
) {
  if (!projectId) return undefined;
  const project = await host.store.getProject(projectId).catch(() => null);
  const entry = await host.types.forProject(project).catch(() => undefined);
  return entry?.craftbooks?.[id];
}

/**
 * What this device offers a project type's sessions. The tier is the
 * selected model's: system models count as tiny, an imported file with no
 * catalog entry is classified from its name, as on the desktop.
 */
export async function portableProjectTypeHost(
  host: Pick<PortableProjectTypeSupportHost, 'store' | 'inference' | 'scripts' | 'catalogModelFor'>,
): Promise<ProjectTypeHost> {
  const config = await host.store.readConfig();
  const providerId = MobileProviderIdSchema.catch('llama-cpp').parse(config.provider);
  let modelTier: ProjectTypeHost['modelTier'] = 'tiny';
  if (providerId === 'llama-cpp') {
    const inventory = await host.inference.models?.().catch(() => undefined);
    const modelId = inventory?.selectedModelId;
    modelTier = modelId
      ? classifyModelTier({
          providerName: 'llama-cpp',
          modelId,
          parameterSize: host.catalogModelFor(inventory, modelId)?.parameterSize,
        })
      : undefined;
  }
  return { ...(modelTier ? { modelTier } : {}), scripts: !!host.scripts(), toolsets: false };
}
