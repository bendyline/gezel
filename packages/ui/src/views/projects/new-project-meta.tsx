import type { CatalogItemSummary, ProjectTypeCategory } from '@bendyline/gezel';
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

export type ProjectGlyphId =
  | 'sheet'
  | 'folder'
  | 'envelope'
  | 'branch'
  | 'calendar'
  | 'bubbles'
  | 'chart'
  | 'code'
  | 'frame'
  | 'quill'
  | 'sprout'
  | 'die'
  | 'house'
  | 'coin'
  | 'banner'
  | 'dots';

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
      <path d="M9 7 L4 12 L9 17" />
      <path d="M15 7 L20 12 L15 17" />
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
  { id: 'general', label: 'General', tagline: 'Start simple — a blank bench.', glyph: 'sheet' },
  { id: 'code', label: 'Code', tagline: 'Build and ship software.', glyph: 'code' },
  {
    id: 'communication',
    label: 'Communication',
    tagline: 'Mail, calendars, and conversations.',
    glyph: 'envelope',
  },
  {
    id: 'creative',
    label: 'Photos & Media',
    tagline: 'Images, video, and design work.',
    glyph: 'frame',
  },
  { id: 'writing', label: 'Writing', tagline: 'Drafts, documents, and stories.', glyph: 'quill' },
  {
    id: 'growth',
    label: 'Personal Growth',
    tagline: 'Learn, practice, and keep at it.',
    glyph: 'sprout',
  },
  { id: 'game', label: 'Games', tagline: 'Play, and build worlds.', glyph: 'die' },
  { id: 'data', label: 'Data', tagline: 'Explore and report on datasets.', glyph: 'chart' },
  {
    id: 'home',
    label: 'Home & Family',
    tagline: 'Run the household; care for the people in it.',
    glyph: 'house',
  },
  {
    id: 'money',
    label: 'Money & Small Business',
    tagline: 'Ledgers, invoices, and calm month-ends.',
    glyph: 'coin',
  },
  {
    id: 'events',
    label: 'Events & Journeys',
    tagline: 'Plan the day, make the trip, rally the crowd.',
    glyph: 'banner',
  },
  { id: 'other', label: 'More', tagline: 'Purpose-built for something else.', glyph: 'dots' },
];

export function categoryMeta(id: ProjectTypeCategory): ProjectCategoryMeta {
  return PROJECT_CATEGORIES.find((c) => c.id === id) ?? PROJECT_CATEGORIES[0]!;
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
