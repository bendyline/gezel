import { type CatalogItemSummary, visibleCatalogItems } from '@bendyline/gezel';
import { api } from '../../api.js';

/**
 * The catalog project types a person may start a project from: the preview
 * gate applied, and `email` left out because New Project offers it as its own
 * kind with mailbox linking. New Project's gallery and Home's Create tab read
 * the same list.
 */
export async function loadOfferedProjectTypes(
  showWorkInProgressFeatures: boolean,
): Promise<CatalogItemSummary[]> {
  const types = await api.listCatalogItems('project-type');
  return visibleCatalogItems(types.items, showWorkInProgressFeatures).filter(
    (item) => item.manifest.id !== 'email',
  );
}
