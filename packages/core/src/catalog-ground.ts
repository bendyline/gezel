import {
  type CraftbookCategory,
  CraftbookCategorySchema,
  resolveCraftbookCategory,
} from './craftbook-categories.js';
import { type ProjectTypeCategory, ProjectTypeCategorySchema } from './schemas/catalog.js';

/**
 * The colored paper painted behind a craftbook's or project type's mark.
 *
 * Gilde ships those marks as transparent cut-paper subjects, and the ground
 * comes from the item's category: a shelf in the rail reads as one family, and
 * a mixed gallery groups at a glance. Painting it here rather than baking it
 * into the image keeps every ground exactly its tone, gives dark mode its own
 * values, and lets a tone be retuned without regenerating any artwork.
 *
 * This module only decides which tone. The colors are `--gezel-ground-<tone>`
 * in the UI's foundation palette.
 */
export const CATALOG_GROUND_TONES = [
  'indigo',
  'slate',
  'teal',
  'sage',
  'forest',
  'ochre',
  'terracotta',
  'rose',
  'plum',
] as const;
export type CatalogGroundTone = (typeof CATALOG_GROUND_TONES)[number];

/**
 * Every code shelf has a tone of its own. Each other shelf shares a tone with a
 * code shelf that sits far from it in the rail, so neighbors never match.
 */
export const CRAFTBOOK_CATEGORY_GROUND: Readonly<Record<CraftbookCategory, CatalogGroundTone>> = {
  'code-build': 'indigo',
  'code-quality': 'sage',
  'code-review': 'terracotta',
  'code-data': 'slate',
  'code-release': 'ochre',
  'code-ops': 'forest',
  'code-docs': 'teal',
  writing: 'rose',
  media: 'plum',
  design: 'teal',
  marketing: 'terracotta',
  research: 'indigo',
  business: 'ochre',
  personal: 'sage',
  practice: 'forest',
  other: 'slate',
};

/** Project types follow the craftbook shelf nearest their subject. */
export const PROJECT_TYPE_CATEGORY_GROUND: Readonly<
  Record<ProjectTypeCategory, CatalogGroundTone>
> = {
  general: 'indigo',
  code: 'indigo',
  communication: 'terracotta',
  creative: 'teal',
  writing: 'rose',
  growth: 'forest',
  game: 'plum',
  data: 'slate',
  home: 'sage',
  money: 'ochre',
  business: 'ochre',
  events: 'rose',
  other: 'slate',
};

/**
 * What a connector type brings in. Connector types have no category, so the
 * family is read from the id and tags. It is both the shelf the type sits on
 * in the Add connection gallery and the ground its mark is painted on, so the
 * two can never disagree.
 */
export const CONNECTOR_FAMILIES = [
  'mail',
  'calendars',
  'files',
  'web',
  'social',
  'code',
  'data',
  'devices',
  'other',
] as const;
export type ConnectorFamily = (typeof CONNECTOR_FAMILIES)[number];

/** First match wins; a type that fits none is `other`. */
const CONNECTOR_FAMILY_PATTERNS: readonly (readonly [RegExp, ConnectorFamily])[] = [
  [/\b(camera|webcam|device)\b/, 'devices'],
  [/\b(mail|email|gmail|imap)\b/, 'mail'],
  [/\bcalendar\b/, 'calendars'],
  [/\b(files|documents|drive|onedrive|sharepoint)\b/, 'files'],
  [/\b(github|issues|linear)\b/, 'code'],
  [/\b(social|posts|video|media)\b/, 'social'],
  [/\b(table|logs|telemetry|records|data|json)\b/, 'data'],
  [/\b(web|website|pages|rss|feeds|news)\b/, 'web'],
];

export const CONNECTOR_FAMILY_GROUND: Readonly<Record<ConnectorFamily, CatalogGroundTone>> = {
  devices: 'forest',
  mail: 'terracotta',
  calendars: 'rose',
  files: 'ochre',
  code: 'indigo',
  social: 'plum',
  data: 'slate',
  web: 'teal',
  other: 'sage',
};

export function connectorTypeFamily(manifest: {
  id?: string;
  tags?: readonly string[];
}): ConnectorFamily {
  const words = [manifest.id ?? '', ...(manifest.tags ?? [])]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  return CONNECTOR_FAMILY_PATTERNS.find(([pattern]) => pattern.test(words))?.[1] ?? 'other';
}

export function connectorTypeGround(manifest: {
  id?: string;
  tags?: readonly string[];
}): CatalogGroundTone {
  return CONNECTOR_FAMILY_GROUND[connectorTypeFamily(manifest)];
}

/**
 * The ground for a catalog item's mark, or undefined for kinds whose artwork
 * carries its own ground (knowledge catalogs, toolsets, models).
 */
export function catalogGroundFor(manifest: {
  kind: string;
  id?: string;
  category?: string;
  tags?: readonly string[];
}): CatalogGroundTone | undefined {
  if (manifest.kind === 'connector-type') return connectorTypeGround(manifest);
  if (manifest.kind === 'craftbook-template') {
    const category = CraftbookCategorySchema.safeParse(manifest.category);
    return CRAFTBOOK_CATEGORY_GROUND[
      resolveCraftbookCategory({
        ...(category.success ? { category: category.data } : {}),
        ...(manifest.tags ? { tags: manifest.tags } : {}),
      })
    ];
  }
  if (manifest.kind === 'project-type') {
    const category = ProjectTypeCategorySchema.safeParse(manifest.category);
    return PROJECT_TYPE_CATEGORY_GROUND[category.success ? category.data : 'other'];
  }
  return undefined;
}
