import {
  CRAFTBOOK_CATEGORY_FAMILY_META,
  CRAFTBOOK_CATEGORY_META,
  CRAFTBOOK_ROLE_META,
  type CatalogItemSummary,
  type CraftbookCategory,
  type CraftbookRole,
  type CraftbookSummary,
  type CreateTaskRequest,
  resolveCraftbookCategory,
  visibleCatalogItems,
} from '@bendyline/gezel';

export interface StartCraftbook extends CraftbookSummary {
  /** Catalog source carried into task creation for deterministic resolution. */
  sourceId: string;
  /** Catalog tags retained for wordwheel/search metadata. */
  tags: string[];
  /** Project-lifecycle shelf supplied by the catalog. */
  role: CraftbookRole;
  /** Subject shelf — authored by the catalog or inferred from tags. */
  category: CraftbookCategory;
}

export interface StartCraftbookCategory {
  id: string;
  label: string;
  hint: string;
  bookIds: Set<string>;
}

/**
 * Convert the project-applicable catalog response into the compact shape the
 * CLI picker and wordwheel share. The endpoint already places project-local
 * books ahead of same-id catalog entries; retain that precedence defensively.
 */
export function normalizeCraftbooks(
  items: ReadonlyArray<CatalogItemSummary>,
  showWorkInProgressFeatures = false,
): StartCraftbook[] {
  const byId = new Map<string, StartCraftbook>();
  for (const item of visibleCatalogItems(items, showWorkInProgressFeatures)) {
    if (item.manifest.kind !== 'craftbook-template') continue;
    const manifest = item.manifest;
    if (byId.has(manifest.id)) continue;
    byId.set(manifest.id, {
      id: manifest.id,
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      version: manifest.version,
      sourceId: item.sourceId,
      source:
        item.sourceId === 'project' ? 'project' : item.sourceId === 'local' ? 'local' : 'bundled',
      stepCount: manifest.steps.length,
      tags: manifest.tags ?? [],
      role: manifest.role ?? 'general',
      category: resolveCraftbookCategory(manifest),
    });
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * First-stage `/do` choices. The active project's curated recommendation
 * is first, followed by project-local work, subject shelves that have at
 * least one match, and an escape hatch containing the complete inventory.
 * Shelves arrive in family order (any-work, code, non-code) and name their
 * family in the hint, since a flat list has no room for group headings.
 */
export function craftbookCategories(
  books: ReadonlyArray<StartCraftbook>,
  suggestedIds: ReadonlySet<string>,
  projectType: { id: string; label: string } | null,
): StartCraftbookCategory[] {
  const categories: StartCraftbookCategory[] = [];
  const allIds = new Set(books.map((book) => book.id));
  const recommended = new Set([...suggestedIds].filter((id) => allIds.has(id)));
  if (recommended.size > 0) {
    categories.push({
      id: 'recommended',
      label: projectType ? `Recommended for ${projectType.label}` : 'Recommended',
      hint: countLabel(recommended.size),
      bookIds: recommended,
    });
  }

  const projectBooks = new Set(
    books.filter((book) => book.source === 'project').map((book) => book.id),
  );
  if (projectBooks.size > 0) {
    categories.push({
      id: 'project',
      label: 'Project craftbooks',
      hint: countLabel(projectBooks.size),
      bookIds: projectBooks,
    });
  }

  const starterMeta = CRAFTBOOK_ROLE_META.find((role) => role.id === 'project-starter');
  if (starterMeta) {
    const bookIds = new Set(
      books.filter((book) => book.role === 'project-starter').map((book) => book.id),
    );
    if (bookIds.size > 0) {
      categories.push({
        id: `role:${starterMeta.id}`,
        label: starterMeta.label,
        hint: countLabel(bookIds.size),
        bookIds,
      });
    }
  }

  for (const family of CRAFTBOOK_CATEGORY_FAMILY_META) {
    for (const meta of CRAFTBOOK_CATEGORY_META) {
      if (meta.family !== family.id) continue;
      const bookIds = new Set(
        books.filter((book) => book.category === meta.id).map((book) => book.id),
      );
      if (bookIds.size === 0) continue;
      categories.push({
        id: `category:${meta.id}`,
        label: meta.label,
        hint:
          family.id === 'universal'
            ? countLabel(bookIds.size)
            : `${family.label} · ${countLabel(bookIds.size)}`,
        bookIds,
      });
    }
  }

  categories.push({
    id: 'all',
    label: 'All craftbooks',
    hint: countLabel(allIds.size),
    bookIds: allIds,
  });
  return categories;
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'craftbook' : 'craftbooks'}`;
}

export function findCraftbook(
  books: ReadonlyArray<StartCraftbook>,
  value: string,
): StartCraftbook | undefined {
  const query = value.trim().toLowerCase();
  return books.find((book) => book.id.toLowerCase() === query || book.name.toLowerCase() === query);
}

/** Build the one-shot, immediately-dispatched task behind `/do`. */
export function craftbookStartRequest(book: StartCraftbook): CreateTaskRequest {
  const summary = book.description?.trim();
  const description = summary
    ? `Start the "${book.name}" craftbook for this project. ${summary}`
    : `Start the "${book.name}" craftbook for this project. Follow every step in the recipe and verify its required outcomes before completing the task.`;
  return {
    title: book.name,
    description,
    craftbookId: book.id,
    craftbookSourceId: book.sourceId,
    ...(book.version ? { craftbookVersion: book.version } : {}),
    dispatchEntry: true,
  };
}
