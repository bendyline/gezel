import {
  type CatalogItemSummary,
  connectorCraftbookIds,
  visibleCatalogItems,
} from '@bendyline/gezel';
import { api } from '../../api.js';

/**
 * The catalog project types a person may start a project from: the
 * work-in-progress gate applied, and `email` left out because New Project
 * offers it as its own kind with mailbox linking. New Project's gallery and
 * Home's Make something read the same list.
 */
export async function loadOfferedProjectTypes(
  showWorkInProgressFeatures: boolean,
): Promise<CatalogItemSummary[]> {
  const [types, books] = await Promise.all([
    api.listCatalogItems('project-type'),
    showWorkInProgressFeatures
      ? Promise.resolve({ items: [] as CatalogItemSummary[] })
      : api.listCatalogItems('craftbook-template'),
  ]);
  return visibleCatalogItems(
    types.items,
    showWorkInProgressFeatures,
    connectorCraftbookIds(books.items),
  ).filter((item) => item.manifest.id !== 'email');
}
