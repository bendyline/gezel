import {
  type CatalogItemSummary,
  PROJECT_CATEGORY_ICONS,
  type ProjectIconId,
  type ProjectTypeCategory,
  projectTypeIcon,
} from '@bendyline/gezel';
import type { JSX } from 'react';

/**
 * Category registry + glyphs for the New Project gallery. Categories are a
 * fixed, ordered list the UI fully controls (the wire enum lives in core's
 * `ProjectTypeCategorySchema`); the gallery only shows a category when at
 * least one type claims it, so new catalog content lights rail entries up
 * without any dialog changes.
 *
 * Glyphs follow the home-screen idiom (`views/home/glyphs.tsx`): inline
 * 24×24 currentColor strokes, no external assets.
 */

/** UI alias retained for callers that think in rendering rather than schema terms. */
export type ProjectGlyphId = ProjectIconId;

const GLYPH_PATHS: Record<ProjectGlyphId, JSX.Element> = {
  sheet: (
    <>
      <path d="M7 3.5 H14.5 L18.5 7.5 V20.5 H7 Z" />
      <path d="M14.5 3.5 V7.5 H18.5" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 6.5 A1.5 1.5 0 0 1 5 5 H9.5 L11.5 7.5 H19 A1.5 1.5 0 0 1 20.5 9 V17.5 A1.5 1.5 0 0 1 19 19 H5 A1.5 1.5 0 0 1 3.5 17.5 Z" />
    </>
  ),
  envelope: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M4.5 7 L12 13 L19.5 7" />
    </>
  ),
  branch: (
    <>
      <circle cx="6.5" cy="6" r="2.2" />
      <circle cx="6.5" cy="18" r="2.2" />
      <circle cx="17.5" cy="9" r="2.2" />
      <path d="M6.5 8.2 V15.8" />
      <path d="M17.5 11.2 C17.5 14.5 12 13.5 9 15.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="1.5" />
      <path d="M4 10 H20" />
      <path d="M8.5 3.5 V7" />
      <path d="M15.5 3.5 V7" />
    </>
  ),
  bubbles: (
    <>
      <path d="M4 5.5 H15 A1.5 1.5 0 0 1 16.5 7 V12 A1.5 1.5 0 0 1 15 13.5 H8.5 L5.5 16 V13.5 H4 A1.5 1.5 0 0 1 2.5 12 V7 A1.5 1.5 0 0 1 4 5.5 Z" />
      <path d="M18.5 9.5 H20 A1.5 1.5 0 0 1 21.5 11 V15.5 A1.5 1.5 0 0 1 20 17 H19.5 V19.5 L16.5 17 H12.5" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4 V20 H20" />
      <path d="M8 16.5 V11" />
      <path d="M12.5 16.5 V7.5" />
      <path d="M17 16.5 V13" />
    </>
  ),
  code: (
    <>
      <path d="M9.5 4.5 H8.5 C7 4.5 7 5.5 7 7 V9.5 C7 10.8 6.3 11.5 5 12 C6.3 12.5 7 13.2 7 14.5 V17 C7 18.5 7.5 19.5 9.5 19.5" />
      <path d="M14.5 4.5 H15.5 C17 4.5 17 5.5 17 7 V9.5 C17 10.8 17.7 11.5 19 12 C17.7 12.5 17 13.2 17 14.5 V17 C17 18.5 16.5 19.5 14.5 19.5" />
    </>
  ),
  frame: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="M3.5 16.5 L9.5 12.5 L13.5 15.5 L17 13 L20.5 15.5" />
    </>
  ),
  quill: (
    <>
      <path d="M19.5 4.5 C13 5 8.5 9.5 6.5 15.5 L5 19 L8.5 17.5 C14.5 15.5 19 11 19.5 4.5 Z" />
      <path d="M5.5 18.5 C9 13 13 9.5 16.5 7.5" />
    </>
  ),
  sprout: (
    <>
      <path d="M12 21 V11" />
      <path d="M12 14.4 C8.5 14.4 6.4 11.9 6.4 8.4 C9.9 8.4 12 10.9 12 14" fillOpacity={0.18} />
      <path d="M12 12.4 C15.5 12.4 17.6 9.9 17.6 6.4 C14.1 6.4 12 8.9 12 12" fillOpacity={0.18} />
    </>
  ),
  die: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
      <circle cx="9" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  house: (
    <>
      <path d="M4 11 L12 4.5 L20 11" />
      <path d="M6 10 V19.5 H18 V10" />
      <path d="M10 19.5 V14.5 H14 V19.5" />
    </>
  ),
  coin: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8 C10 8 9.2 9 9.2 10 C9.2 12.5 14.8 11.5 14.8 14 C14.8 15 14 16 12 16" />
      <path d="M12 6.8 V8" />
      <path d="M12 16 V17.2" />
    </>
  ),
  banner: (
    <>
      <path d="M6 3.5 V20.5" />
      <path d="M6 5 H18.5 L15.5 8.75 L18.5 12.5 H6" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M7 9 L10 12 L7 15" />
      <path d="M12.5 15 H17" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4.5 9 H19.5 M4.5 15 H19.5" />
      <path d="M12 4 C15.5 7.6 15.5 16.4 12 20 C8.5 16.4 8.5 7.6 12 4 Z" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4.5" width="16" height="6" rx="1.3" />
      <rect x="4" y="13.5" width="16" height="6" rx="1.3" />
      <path d="M7 7.5 H7.1 M7 16.5 H7.1 M10 7.5 H16.5 M10 16.5 H16.5" />
    </>
  ),
  package: (
    <>
      <path d="M4.5 8 L12 4 L19.5 8 V16 L12 20 L4.5 16 Z" />
      <path d="M4.5 8 L12 12 L19.5 8 M12 12 V20" />
      <path d="M8.5 6 L16 10" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5 H9.5 C11 5.5 12 6.5 12 8 V19 C12 17.5 11 16.5 9.5 16.5 H4 Z" />
      <path d="M20 5.5 H14.5 C13 5.5 12 6.5 12 8 V19 C12 17.5 13 16.5 14.5 16.5 H20 Z" />
    </>
  ),
  palette: (
    <>
      <path d="M12 4 C7.3 4 4 7.2 4 11.5 C4 16 7.5 19.5 12 19.5 H13.2 C14.2 19.5 14.7 18.3 14 17.6 C13.2 16.8 13.7 15.5 14.8 15.5 H17 C19 15.5 20 14.1 20 12 C20 7.4 16.7 4 12 4 Z" />
      <circle cx="8" cy="9" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="16" cy="9.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="9" cy="13" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8 H7 L8.5 5.5 H15.5 L17 8 H20 V18.5 H4 Z" />
      <circle cx="12" cy="13" r="3.3" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3.5" y="7.5" width="17" height="12" rx="1.5" />
      <path d="M8.5 7.5 V5.5 H15.5 V7.5 M3.5 12.5 C8 15 16 15 20.5 12.5" />
      <path d="M12 12.8 V15.2" />
    </>
  ),
  heart: (
    <path d="M12 20 C9 17.5 4.5 14.6 4.5 9.7 C4.5 6.8 6.3 5 8.8 5 C10.3 5 11.4 5.8 12 7 C12.6 5.8 13.7 5 15.2 5 C17.7 5 19.5 6.8 19.5 9.7 C19.5 14.6 15 17.5 12 20 Z" />
  ),
  cards: (
    <>
      <rect x="5" y="5.5" width="11" height="14" rx="1.5" />
      <path d="M9 5.5 V4.5 A1.5 1.5 0 0 1 10.5 3 H17.5 A1.5 1.5 0 0 1 19 4.5 V15.5 A1.5 1.5 0 0 1 17.5 17 H16" />
      <path d="M8 10 H13 M8 13 H12" />
    </>
  ),
  meal: (
    <>
      <path d="M5 4.5 V10 M3.5 4.5 V8 C3.5 9.3 4.1 10 5 10 C5.9 10 6.5 9.3 6.5 8 V4.5 M5 10 V20" />
      <path d="M15 4.5 C18 6.5 18.5 10.5 16 13.5 V20 M16 13.5 H13.5 V9 C13.5 6.7 14 5.3 15 4.5 Z" />
    </>
  ),
  plane: (
    <>
      <path d="M3.5 13 L20.5 5.5 L15.5 19 L11.5 13.5 Z" />
      <path d="M11.5 13.5 L20.5 5.5 M11.5 13.5 V18 L8.5 15" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19 C4 15.5 6 14 9 14 C12 14 14 15.5 14.5 19" />
      <path d="M14.5 7 C17 7 18.5 8.5 18.5 10.5 C18.5 12 17.7 13 16.5 13.7 M16 15 C18.5 15.3 20 16.5 20.5 19" />
    </>
  ),
  dots: (
    <>
      <circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
};

export function ProjectGlyph({ glyph, size = 18 }: { glyph: ProjectGlyphId; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-project-glyph={glyph}
    >
      {GLYPH_PATHS[glyph]}
    </svg>
  );
}

export interface ProjectCategoryMeta {
  id: ProjectTypeCategory;
  label: string;
  /** One-line eyebrow under the category's section header in the gallery. */
  tagline: string;
  glyph: ProjectGlyphId;
}

/** Ordered registry — rail and gallery sections render in this order. */
export const PROJECT_CATEGORIES: ProjectCategoryMeta[] = [
  {
    id: 'general',
    label: 'General',
    tagline: 'Start simple — a blank bench.',
    glyph: PROJECT_CATEGORY_ICONS.general,
  },
  {
    id: 'code',
    label: 'Code',
    tagline: 'Build and ship software.',
    glyph: PROJECT_CATEGORY_ICONS.code,
  },
  {
    id: 'communication',
    label: 'Communication',
    tagline: 'Mail, calendars, and conversations.',
    glyph: PROJECT_CATEGORY_ICONS.communication,
  },
  {
    id: 'creative',
    label: 'Photos & Media',
    tagline: 'Images, video, and design work.',
    glyph: PROJECT_CATEGORY_ICONS.creative,
  },
  {
    id: 'writing',
    label: 'Writing',
    tagline: 'Drafts, documents, and stories.',
    glyph: PROJECT_CATEGORY_ICONS.writing,
  },
  {
    id: 'growth',
    label: 'Personal Growth',
    tagline: 'Learn, practice, and keep at it.',
    glyph: PROJECT_CATEGORY_ICONS.growth,
  },
  {
    id: 'game',
    label: 'Games',
    tagline: 'Play, and build worlds.',
    glyph: PROJECT_CATEGORY_ICONS.game,
  },
  {
    id: 'data',
    label: 'Data',
    tagline: 'Explore and report on datasets.',
    glyph: PROJECT_CATEGORY_ICONS.data,
  },
  {
    id: 'home',
    label: 'Home & Family',
    tagline: 'Run the household; care for the people in it.',
    glyph: PROJECT_CATEGORY_ICONS.home,
  },
  {
    id: 'money',
    label: 'Money & Small Business',
    tagline: 'Ledgers, invoices, and calm month-ends.',
    glyph: PROJECT_CATEGORY_ICONS.money,
  },
  {
    id: 'events',
    label: 'Events & Journeys',
    tagline: 'Plan the day, make the trip, rally the crowd.',
    glyph: PROJECT_CATEGORY_ICONS.events,
  },
  {
    id: 'other',
    label: 'More',
    tagline: 'Purpose-built for something else.',
    glyph: PROJECT_CATEGORY_ICONS.other,
  },
];

export function categoryMeta(id: ProjectTypeCategory): ProjectCategoryMeta {
  return PROJECT_CATEGORIES.find((c) => c.id === id) ?? PROJECT_CATEGORIES[0]!;
}

/** Maker's mark for a catalog project type, including community types. */
export function catalogProjectTypeGlyph(item: CatalogItemSummary): ProjectGlyphId {
  const manifest = item.manifest;
  if (manifest.kind !== 'project-type') return 'dots';
  return projectTypeIcon({
    id: manifest.id,
    icon: manifest.icon,
    extends: manifest.extends,
    category: manifest.category,
    tags: manifest.tags,
  });
}

/**
 * Broad "kind" of project chosen in the New Project dialog. Selects which
 * configuration section shows. `general` is the plain project; `github` reveals
 * the repo field; `email` stamps the `email` project type (the mailbox is linked
 * from the project's Mail tab after creation). Future kinds (calendar, group
 * messaging, data analysis) are shown disabled until their rails land.
 */
export type ProjectKindId = 'general' | 'email' | 'github' | 'folder';

export interface ProjectKindMeta {
  id: ProjectKindId | 'calendar' | 'messaging' | 'data';
  label: string;
  description: string;
  soon?: boolean;
  category: ProjectTypeCategory;
  glyph: ProjectGlyphId;
  /** Hand-written "Gezellen and Tools" lines for the detail pane. */
  give: string[];
}

export const PROJECT_KINDS: ProjectKindMeta[] = [
  {
    id: 'general',
    label: 'General',
    description: 'A flexible project with a blank workspace.',
    category: 'general',
    glyph: 'sheet',
    give: [
      'A blank workspace your crew reads and writes',
      'Your About and mission set the direction',
    ],
  },
  {
    id: 'email',
    label: 'E-Mail',
    description: 'Work from a connected mailbox.',
    category: 'communication',
    glyph: 'envelope',
    give: [
      'Mailbox synced as searchable markdown',
      'Triage and drafting; sending stays consent-gated',
    ],
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Start from a GitHub repository.',
    category: 'code',
    glyph: 'branch',
    give: ['Repo-linked workspace, cloned locally', 'About drafted from the README'],
  },
  {
    id: 'folder',
    label: 'Existing Folder',
    description: 'Work in an existing folder on this computer.',
    category: 'general',
    glyph: 'folder',
    give: ['Works directly in a folder you choose', 'Name and About suggested from what it finds'],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    description: 'Plan and coordinate around a calendar.',
    soon: true,
    category: 'communication',
    glyph: 'calendar',
    give: [],
  },
  {
    id: 'messaging',
    label: 'Group messaging',
    description: 'Organize work around a shared conversation.',
    soon: true,
    category: 'communication',
    glyph: 'bubbles',
    give: [],
  },
  {
    id: 'data',
    label: 'Data analysis',
    description: 'Explore and report on a dataset.',
    soon: true,
    category: 'data',
    glyph: 'chart',
    give: [],
  },
];

/**
 * Category for a catalog project type: the identity manifest's declared
 * `category` wins; a tiny keyword heuristic covers older/community types;
 * `other` is the catch-all (rendered as the "More" section, never hidden).
 */
export function categorizeCatalogType(item: CatalogItemSummary): ProjectTypeCategory {
  const manifest = item.manifest;
  if (manifest.kind !== 'project-type') return 'other';
  if (manifest.category) return manifest.category;
  const haystack =
    `${manifest.id} ${manifest.tags.join(' ')} ${manifest.extends ?? ''}`.toLowerCase();
  if (/design|media|photo|image|video|art/.test(haystack)) return 'creative';
  if (/language|learn|habit|practice|coach/.test(haystack)) return 'growth';
  if (/write|writing|blog|story|content/.test(haystack)) return 'writing';
  if (/game/.test(haystack)) return 'game';
  if (/data|analysis|report/.test(haystack)) return 'data';
  if (/code|web-app|api|cli|library|site/.test(haystack)) return 'code';
  if (/mail|email|calendar|chat|messag/.test(haystack)) return 'communication';
  return 'other';
}
