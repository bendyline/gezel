import { z } from 'zod';

/**
 * Gezel project icons are small, single-colour "maker's marks" rather than
 * avatars. They are intentionally semantic and finite: a custom project type
 * can choose a mark without shipping artwork, every theme can recolour it,
 * and the same mark remains legible from the 22px sidebar tile up to a gallery
 * hero. Rich catalog logos and future generated project artwork are a separate
 * presentation layer.
 */
export const ProjectIconIdSchema = z.enum([
  'sheet',
  'folder',
  'code',
  'branch',
  'envelope',
  'calendar',
  'bubbles',
  'chart',
  'frame',
  'quill',
  'sprout',
  'die',
  'house',
  'coin',
  'banner',
  'terminal',
  'globe',
  'server',
  'package',
  'book',
  'palette',
  'camera',
  'briefcase',
  'heart',
  'cards',
  'meal',
  'plane',
  'people',
  'dots',
]);
export type ProjectIconId = z.infer<typeof ProjectIconIdSchema>;

/** Stable category defaults for custom types that do not declare a mark. */
export const PROJECT_CATEGORY_ICONS = {
  general: 'sheet',
  code: 'code',
  communication: 'envelope',
  creative: 'frame',
  writing: 'quill',
  growth: 'sprout',
  game: 'die',
  data: 'chart',
  home: 'house',
  money: 'coin',
  business: 'briefcase',
  events: 'banner',
  other: 'dots',
} as const satisfies Readonly<Record<string, ProjectIconId>>;

/**
 * Compatibility map for taxonomy entries and bundled types that predate the
 * declarative `icon` field. Keep this focused on durable concepts; unknown
 * community types continue through tag/category inference below.
 */
const PROJECT_TYPE_ICONS: Readonly<Record<string, ProjectIconId>> = {
  'browser-game': 'die',
  'web-app': 'code',
  'static-site': 'globe',
  'data-analysis': 'chart',
  'api-service': 'server',
  'cli-tool': 'terminal',
  library: 'package',
  'content-writing': 'quill',
  'media-production': 'camera',
  'design-prototype': 'palette',
  'social-media': 'bubbles',
  email: 'envelope',
  'job-hunt': 'briefcase',
  'caregiving-binder': 'heart',
  checkers: 'die',
  chess: 'die',
  'design-scheme': 'palette',
  'event-planner': 'calendar',
  'fitness-coach': 'sprout',
  flashcards: 'cards',
  'freelance-office': 'briefcase',
  'fundraiser-hq': 'heart',
  go: 'die',
  'household-budget': 'coin',
  'household-manual': 'house',
  'image-feed': 'camera',
  'just-chat': 'bubbles',
  'language-trainer': 'book',
  'life-binder': 'book',
  'meal-planner': 'meal',
  'novel-writing-room': 'quill',
  'social-feed': 'bubbles',
  'trip-planner': 'plane',
};

export interface ProjectTypeIconHints {
  id?: string;
  /** Explicit maker's mark declared by a taxonomy or catalog type. */
  icon?: ProjectIconId;
  /** Optional taxonomy base inherited by a custom type. */
  extends?: string;
  category?: string;
  tags?: readonly string[];
}

/**
 * Resolve a type's maker's mark. Explicit declarations win; the remaining
 * inference is deterministic so older and community types get a useful mark
 * without acquiring mutable presentation state.
 */
export function projectTypeIcon(hints: ProjectTypeIconHints): ProjectIconId {
  if (hints.icon) return hints.icon;
  const idIcon = hints.id ? PROJECT_TYPE_ICONS[hints.id] : undefined;
  if (idIcon) return idIcon;
  const inheritedIcon = hints.extends ? PROJECT_TYPE_ICONS[hints.extends] : undefined;
  if (inheritedIcon) return inheritedIcon;

  const words = [hints.id, ...(hints.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
  if (/\b(api|backend|server|service|webhook)\b/.test(words)) return 'server';
  if (/\b(cli|terminal|shell|command)\b/.test(words)) return 'terminal';
  if (/\b(code|coding|developer|software|repository|github)\b/.test(words)) return 'code';
  if (/\b(site|website|web)\b/.test(words)) return 'globe';
  if (/\b(data|analysis|analytics|metrics|report)\b/.test(words)) return 'chart';
  if (/\b(photo|image|camera|video|media)\b/.test(words)) return 'camera';
  if (/\b(design|palette|brand|color|prototype)\b/.test(words)) return 'palette';
  if (/\b(write|writing|novel|story|copy|content)\b/.test(words)) return 'quill';
  if (/\b(mail|email|inbox|correspondence)\b/.test(words)) return 'envelope';
  if (/\b(chat|social|conversation|message|feed)\b/.test(words)) return 'bubbles';
  if (/\b(game|play|chess|checkers|board-game)\b/.test(words)) return 'die';
  if (/\b(travel|trip|journey|itinerary)\b/.test(words)) return 'plane';
  if (/\b(event|calendar|wedding|party)\b/.test(words)) return 'calendar';
  if (/\b(job|career|freelance|client|business)\b/.test(words)) return 'briefcase';
  if (/\b(budget|finance|money|invoice|ledger)\b/.test(words)) return 'coin';
  if (/\b(meal|recipe|food|cooking|pantry)\b/.test(words)) return 'meal';
  if (/\b(care|health|family|fundrais|charity)\b/.test(words)) return 'heart';
  if (/\b(language|learn|study|flashcard|documentation|binder)\b/.test(words)) return 'book';
  if (/\b(home|house|household)\b/.test(words)) return 'house';
  if (/\b(team|people|community|group)\b/.test(words)) return 'people';

  const categoryIcon = (PROJECT_CATEGORY_ICONS as Readonly<Record<string, ProjectIconId>>)[
    hints.category ?? 'other'
  ];
  return categoryIcon ?? 'dots';
}

/** Minimal shape needed to resolve a persisted project instance's mark. */
export interface ProjectIconSource {
  /** Explicit per-project override. */
  icon?: ProjectIconId;
  projectType?: { id: string; icon?: ProjectIconId };
  projectTypeId?: string;
  detectedProjectType?: { id: string };
  github?: { url: string };
  workingDir?: string;
}

/**
 * Project icon inheritance, in one place:
 * instance override → applied custom type → taxonomy override/detection →
 * connected-folder affordance → general sheet.
 */
export function resolveProjectIcon(project: ProjectIconSource): ProjectIconId {
  if (project.icon) return project.icon;
  if (project.projectType) {
    return projectTypeIcon({ id: project.projectType.id, icon: project.projectType.icon });
  }
  const taxonomyId = project.projectTypeId ?? project.detectedProjectType?.id;
  if (taxonomyId) return projectTypeIcon({ id: taxonomyId });
  if (project.github?.url) return 'branch';
  if (project.workingDir) return 'folder';
  return 'sheet';
}

/**
 * A project's own icon art, kept beside its `project.json`: a mark a model
 * drew for it, or a picture the person uploaded. It stands in for the maker's
 * mark wherever the project's icon shows. Choosing a mark again removes it.
 */
export const ProjectCustomIconFormatSchema = z.enum(['svg', 'png', 'jpeg', 'webp']);
export type ProjectCustomIconFormat = z.infer<typeof ProjectCustomIconFormatSchema>;

export const ProjectCustomIconSchema = z.object({
  /**
   * `drawn` is a one-color mark, shown in the theme's ink like the built-in
   * marks. `image` is a picture, shown as it is.
   */
  kind: z.enum(['drawn', 'image']),
  format: ProjectCustomIconFormatSchema,
  /** Changes whenever the art does, so a client knows to fetch it again. */
  updatedAt: z.string(),
});
export type ProjectCustomIcon = z.infer<typeof ProjectCustomIconSchema>;

export type ProjectIconImageFormat = Exclude<ProjectCustomIconFormat, 'svg'>;

/** An uploaded picture is small: the app scales it down before sending it. */
export const PROJECT_ICON_IMAGE_MAX_BYTES = 512 * 1024;
/** A drawn mark is a handful of shapes; a long one is not a mark. */
export const PROJECT_ICON_SVG_MAX_CHARS = 24_000;
/** The description a person gives the model of what to draw. */
export const PROJECT_ICON_BRIEF_MAX_CHARS = 600;

export const PROJECT_ICON_MEDIA_TYPES = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const satisfies Readonly<Record<ProjectCustomIconFormat, string>>;

/**
 * What a picture's own first bytes say it is, or null when it is not a PNG,
 * JPEG or WebP. A declared type or a file name is never taken for it.
 */
export function sniffProjectIconImage(bytes: Uint8Array): ProjectIconImageFormat | null {
  const starts = (...signature: number[]) =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpeg';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}
