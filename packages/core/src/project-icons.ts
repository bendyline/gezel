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
