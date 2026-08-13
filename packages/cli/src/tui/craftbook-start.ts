import {
  CRAFTBOOK_ROLE_META,
  type CatalogItemSummary,
  type CraftbookRole,
  type CraftbookSummary,
  type CreateTaskRequest,
} from '@bendyline/gezel';

export interface StartCraftbook extends CraftbookSummary {
  /** Catalog source carried into task creation for deterministic resolution. */
  sourceId: string;
  /** Catalog tags retained for wordwheel/search metadata. */
  tags: string[];
  /** Project-lifecycle shelf supplied by the catalog. */
  role: CraftbookRole;
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
export function normalizeCraftbooks(items: ReadonlyArray<CatalogItemSummary>): StartCraftbook[] {
  const byId = new Map<string, StartCraftbook>();
  for (const item of items) {
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
    });
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * First-stage `/do` choices. The active project's curated recommendation
 * is first, followed by project-local work, lifecycle-role shelves that have
 * at least one match, and an escape hatch containing the complete inventory.
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

  for (const role of CRAFTBOOK_ROLE_META) {
    const bookIds = new Set(books.filter((book) => book.role === role.id).map((book) => book.id));
    if (bookIds.size === 0) continue;
    categories.push({
      id: `role:${role.id}`,
      label: role.label,
      hint: countLabel(bookIds.size),
      bookIds,
    });
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
