import type {
  CatalogItemSummary,
  CraftbookCategory,
  CraftbookCategoryFamily,
  CraftbookTemplateManifest,
  ProjectType,
} from '@bendyline/gezel';
import {
  CRAFTBOOK_CATEGORY_FAMILY_META,
  CRAFTBOOK_CATEGORY_META,
  CRAFTBOOK_ROLE_META,
  listProjectTypes,
  resolveCraftbookCategory,
} from '@bendyline/gezel';
import { seedableParamDefault } from '../../components/craftbook-command.js';
import type { ProjectGlyphId } from '../projects/new-project-meta.js';

/**
 * Lens + card metadata for the New Task dialog's craftbook gallery.
 *
 * "Recommended" stays project-type-aware. The browse rail below it shelves
 * the catalog by subject category, grouped by subject family, because the
 * lifecycle role alone leaves a code project staring at one 190-book pile
 * called "General work" that is mostly recipes about media and household
 * admin. The one role shelf worth keeping beside the categories is
 * "New project starters", which the service already drops for an
 * established codebase.
 */

/** A craftbook catalog item narrowed to its manifest kind. */
export interface BookItem {
  item: CatalogItemSummary;
  manifest: CraftbookTemplateManifest;
}

/** Keep only craftbook-template items, pre-narrowed for the gallery. */
export function toBookItems(items: CatalogItemSummary[]): BookItem[] {
  const out: BookItem[] = [];
  for (const item of items) {
    if (item.manifest.kind === 'craftbook-template') {
      out.push({ item, manifest: item.manifest });
    }
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export interface TaskLens {
  id: string;
  label: string;
  tagline: string;
  glyph: ProjectGlyphId;
  bookIds: Set<string>;
  /** Rail group this shelf sits in; `universal` shelves render ungrouped. */
  family: CraftbookCategoryFamily;
}

/** Rail group heading, or `null` for the ungrouped shelves at the top. */
export function taskLensGroupLabel(family: CraftbookCategoryFamily): string | null {
  if (family === 'universal') return null;
  return CRAFTBOOK_CATEGORY_FAMILY_META.find((meta) => meta.id === family)?.label ?? null;
}

function lensTagSet(type: ProjectType): Set<string> {
  return new Set(type.craftbookTags.map((t) => t.toLowerCase()));
}

function bookMatchesTags(manifest: CraftbookTemplateManifest, wanted: Set<string>): boolean {
  return (manifest.tags ?? []).some((t) => wanted.has(t.toLowerCase()));
}

const CATEGORY_GLYPH: Record<CraftbookCategory, ProjectGlyphId> = {
  'code-build': 'code',
  'code-quality': 'branch',
  'code-review': 'cards',
  'code-data': 'server',
  'code-release': 'package',
  'code-ops': 'chart',
  'code-docs': 'book',
  writing: 'quill',
  media: 'camera',
  design: 'palette',
  marketing: 'banner',
  research: 'globe',
  business: 'briefcase',
  personal: 'house',
  practice: 'sprout',
  other: 'dots',
};

/**
 * The shelves that have at least one matching book in the given
 * project-applicable subset. Empty shelves are dropped, which is what makes
 * the rail read differently on a codebase and on a household project without
 * either of them needing to know the taxonomy.
 */
export function taskLensesFor(books: BookItem[]): TaskLens[] {
  const out: TaskLens[] = [];

  const starterMeta = CRAFTBOOK_ROLE_META.find((role) => role.id === 'project-starter');
  if (starterMeta) {
    const bookIds = new Set(
      books
        .filter((book) => (book.manifest.role ?? 'general') === 'project-starter')
        .map((book) => book.manifest.id),
    );
    if (bookIds.size > 0) {
      out.push({
        id: `role:${starterMeta.id}`,
        label: starterMeta.label,
        tagline: starterMeta.description,
        glyph: 'sprout',
        bookIds,
        family: 'universal',
      });
    }
  }

  const byCategory = new Map<CraftbookCategory, Set<string>>();
  for (const book of books) {
    const category = resolveCraftbookCategory(book.manifest);
    let ids = byCategory.get(category);
    if (!ids) {
      ids = new Set();
      byCategory.set(category, ids);
    }
    ids.add(book.manifest.id);
  }
  for (const family of CRAFTBOOK_CATEGORY_FAMILY_META) {
    for (const meta of CRAFTBOOK_CATEGORY_META) {
      if (meta.family !== family.id) continue;
      const bookIds = byCategory.get(meta.id);
      if (!bookIds || bookIds.size === 0) continue;
      out.push({
        id: `category:${meta.id}`,
        label: meta.label,
        tagline: meta.description,
        glyph: CATEGORY_GLYPH[meta.id],
        bookIds,
        family: meta.family,
      });
    }
  }
  return out;
}

/** Card/hero glyph for a book without its own icon: first matching lens. */
export function craftbookGlyph(manifest: CraftbookTemplateManifest): ProjectGlyphId {
  for (const type of listProjectTypes()) {
    if (bookMatchesTags(manifest, lensTagSet(type))) {
      return type.icon;
    }
  }
  return 'sheet';
}

/** The blank-task card shown at the head of the gallery. */
export const GENERAL_TASK_CARD = {
  label: 'General task',
  description: 'Start blank — describe the job, list the steps, and fire it when ready.',
  glyph: 'sprout' as ProjectGlyphId,
};

/** A craftbook declares params iff its paramSchema has at least one property. */
export function craftbookHasParams(manifest: CraftbookTemplateManifest): boolean {
  const props = (manifest.paramSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return !!props && Object.keys(props).length > 0;
}

/**
 * The task description for a craftbook launch. Mirrors the terminal
 * launcher's `craftbookInvoker` composition (service.ts) so a task reads
 * the same regardless of which surface launched it — and the fixed
 * prefix keeps the create request over the 40-char minimum even for
 * books with a terse manifest description.
 */
export function composeCraftbookDescription(
  manifest: CraftbookTemplateManifest,
  params: Record<string, string>,
): string {
  const paramSummary = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const withClause = paramSummary ? ` with ${paramSummary}.` : '.';
  const tail = manifest.description ? ` ${manifest.description}` : '';
  return `Run the "${manifest.name}" craftbook against this project${withClause}${tail}`.slice(
    0,
    2000,
  );
}

/** Coerce a squisq param value object to the wire's `Record<string,string>`. */
export function stringifyParamValues(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'boolean') out[key] = v ? 'true' : 'false';
    else if (typeof v === 'number') out[key] = String(v);
    else if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/**
 * Seed a param object from the schema's declared defaults. Runtime-template
 * defaults (`{{task.dir}}`) are left unseeded — the field stays empty, its
 * description explains the fallback, and the server resolves the token at
 * task creation. See `seedableParamDefault` for why seeding the literal
 * token is actively harmful.
 */
export function seedParamDefaults(schema: unknown): Record<string, unknown> {
  const props = ((schema as { properties?: Record<string, { default?: unknown } | undefined> })
    ?.properties ?? {}) as Record<string, { default?: unknown } | undefined>;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    const seed = seedableParamDefault(def);
    if (seed !== undefined) out[key] = seed;
  }
  return out;
}
