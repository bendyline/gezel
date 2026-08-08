import type { CatalogItemSummary, CraftbookTemplateManifest, ProjectType } from '@bendyline/gezel';
import { CRAFTBOOK_ROLE_META, listProjectTypes } from '@bendyline/gezel';
import type { ProjectGlyphId } from '../projects/new-project-meta.js';

/**
 * Lens + card metadata for the New Task dialog's craftbook gallery.
 *
 * "Recommended" remains project-type-aware, while the browse rail groups
 * the remaining catalog by each craftbook's project-lifecycle role. That
 * keeps "what fits this project type?" separate from "what kind of work is
 * this recipe for?".
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

/** Glyph per project type, used as a card fallback. */
const PROJECT_TYPE_GLYPHS: Record<string, ProjectGlyphId> = {
  'browser-game': 'die',
  'web-app': 'frame',
  'static-site': 'frame',
  'data-analysis': 'chart',
  'api-service': 'code',
  'cli-tool': 'code',
  library: 'code',
  'content-writing': 'quill',
  'media-production': 'frame',
  'design-prototype': 'frame',
  email: 'envelope',
};

export interface TaskLens {
  id: string;
  label: string;
  tagline: string;
  glyph: ProjectGlyphId;
  bookIds: Set<string>;
}

function lensTagSet(type: ProjectType): Set<string> {
  return new Set(type.craftbookTags.map((t) => t.toLowerCase()));
}

function bookMatchesTags(manifest: CraftbookTemplateManifest, wanted: Set<string>): boolean {
  return (manifest.tags ?? []).some((t) => wanted.has(t.toLowerCase()));
}

/**
 * The lifecycle shelves that have at least one matching book in the given
 * project-applicable subset. Project starters disappear automatically when
 * the service identifies an established codebase.
 */
export function taskLensesFor(books: BookItem[]): TaskLens[] {
  const roleGlyph: Record<(typeof CRAFTBOOK_ROLE_META)[number]['id'], ProjectGlyphId> = {
    'project-starter': 'sprout',
    'maintenance-review': 'code',
    general: 'sheet',
  };
  const out: TaskLens[] = [];
  for (const role of CRAFTBOOK_ROLE_META) {
    const bookIds = new Set(
      books
        .filter((book) => (book.manifest.role ?? 'general') === role.id)
        .map((book) => book.manifest.id),
    );
    if (bookIds.size > 0) {
      out.push({
        id: `role:${role.id}`,
        label: role.label,
        tagline: role.description,
        glyph: roleGlyph[role.id],
        bookIds,
      });
    }
  }
  return out;
}

/** Card/hero glyph for a book without its own icon: first matching lens. */
export function craftbookGlyph(manifest: CraftbookTemplateManifest): ProjectGlyphId {
  for (const type of listProjectTypes()) {
    if (bookMatchesTags(manifest, lensTagSet(type))) {
      return PROJECT_TYPE_GLYPHS[type.id] ?? 'sheet';
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

/** Seed a param object from the schema's declared defaults. */
export function seedParamDefaults(schema: unknown): Record<string, unknown> {
  const props = ((schema as { properties?: Record<string, { default?: unknown } | undefined> })
    ?.properties ?? {}) as Record<string, { default?: unknown } | undefined>;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (def && def.default !== undefined) out[key] = def.default;
  }
  return out;
}
