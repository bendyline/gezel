import type { CatalogItemSummary } from './schemas/catalog.js';

const CONNECTOR_PROJECT_TYPE_BASES = new Set(['email', 'social-media']);

/**
 * Resolve the WIP bucket preference from persisted config and the build
 * version. Unstamped checkouts use the repository's `0.0.0` development
 * sentinel; release builds are stamped with their real version.
 */
export function resolveShowWorkInProgressFeatures(
  configured: boolean | undefined,
  buildVersion: string,
): boolean {
  return configured ?? buildVersion === '0.0.0';
}

/**
 * Whether catalog content uses connectors: a craftbook that declares any
 * (optional ones included), or a project type built on one. Connector-backed
 * content was the first preview and left the preview bucket in 1.26313.
 */
export function catalogItemUsesConnectors(
  item: CatalogItemSummary,
  connectorCraftbookIds: ReadonlySet<string> = new Set(),
): boolean {
  const manifest = item.manifest;
  if (manifest.kind === 'craftbook-template') {
    return (manifest.connectors?.length ?? 0) > 0;
  }
  if (manifest.kind !== 'project-type') return false;

  if (manifest.extends && CONNECTOR_PROJECT_TYPE_BASES.has(manifest.extends)) return true;
  if ((manifest.craftbooks ?? []).some((id) => connectorCraftbookIds.has(id))) return true;
  return (manifest.schedules ?? []).some((schedule) =>
    connectorCraftbookIds.has(schedule.craftbook),
  );
}

/** Collect connector-declaring craftbook ids for project-type visibility. */
export function connectorCraftbookIds(items: ReadonlyArray<CatalogItemSummary>): Set<string> {
  return new Set(
    items.flatMap((item) =>
      item.manifest.kind === 'craftbook-template' && catalogItemUsesConnectors(item)
        ? [item.manifest.id]
        : [],
    ),
  );
}

/**
 * Apply the UX/CLI-only preview catalog gate. Service APIs intentionally
 * continue to return and accept this content. No catalog content is in
 * preview today, so every item is visible; launchers keep calling this so the
 * next catalog preview needs no change at their call sites.
 */
export function visibleCatalogItems(
  items: ReadonlyArray<CatalogItemSummary>,
  _showWorkInProgressFeatures: boolean,
  _connectorIds?: ReadonlySet<string>,
): CatalogItemSummary[] {
  return [...items];
}
