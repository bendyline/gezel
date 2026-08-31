import { z } from 'zod';
import { ProjectIconIdSchema } from '../project-icons.js';
import { resolveProjectTypeId } from '../schemas/project.js';

/**
 * Project-type taxonomy — a broad, deliberately expandable catalog of the
 * *kinds of thing a project produces* (a browser game, a data analysis, a
 * REST service, …). It exists so the craftbook rail can suggest a small,
 * relevant subset of the ~200-book catalog instead of dumping all of them on
 * an obvious HTML-game project.
 *
 * Two halves to each entry:
 *   - `detect`  — cheap, deterministic signals scored against a project's
 *                 indexed file mix (extensions, modalities) and its
 *                 `about.md`/mission text (keywords). Drives auto-detection.
 *   - `craftbookTags` — the curated craftbook tags that make a book
 *                 "suggested" for this type. Relevance = tag intersection
 *                 with `CraftbookTemplateManifest.tags`. Keep these aligned
 *                 to tags that actually exist in the catalog (the near-
 *                 universal `gallery` tag is intentionally never used here —
 *                 it would match every book).
 *   - `gezelRoles` — gezel-template affinity in two tiers. `default` is the
 *                 core crew this kind of project normally starts with;
 *                 `suggested` is the useful specialist bench beyond that.
 *                 Detection only surfaces these choices and never creates a
 *                 gezel as a side effect.
 *
 * This is shared core data: the service imports it for detection + craftbook
 * partitioning, and the UI imports it for the settings override dropdown, so
 * there is no list endpoint to keep in sync.
 */

export const ProjectTypeDetectSchema = z.object({
  /**
   * File extensions (lowercase, no dot) characteristic of this type, matched
   * against the project's extension histogram. Note: HTML/CSS are *not*
   * classified as a `lang` by the indexer, so extension matching — not
   * language matching — is the reliable file signal.
   */
  extensions: z.array(z.string()).optional(),
  /** Content modalities (`image`, `doc`, …) characteristic of this type. */
  modalities: z.array(z.string()).optional(),
  /** Lowercase keywords matched (whole-word) against about/mission text. */
  keywords: z.array(z.string()).optional(),
});
export type ProjectTypeDetect = z.infer<typeof ProjectTypeDetectSchema>;

export const ProjectTypeGezelRoleSchema = z.object({
  /** Gezel-template id from the catalog. */
  templateId: z.string(),
  /** Project-type-specific explanation shown with the recommendation. */
  reason: z.string(),
});
export type ProjectTypeGezelRole = z.infer<typeof ProjectTypeGezelRoleSchema>;

export const ProjectTypeGezelAffinitySchema = z.object({
  /** Core roles expected in the standard crew for this type. */
  default: z.array(ProjectTypeGezelRoleSchema),
  /** Additional specialists that often improve this kind of project. */
  suggested: z.array(ProjectTypeGezelRoleSchema),
});
export type ProjectTypeGezelAffinity = z.infer<typeof ProjectTypeGezelAffinitySchema>;

export const ProjectTypeSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  /** Small monochrome maker's mark used by type and project-instance UI. */
  icon: ProjectIconIdSchema,
  detect: ProjectTypeDetectSchema,
  /** Craftbook tags that mark a book "suggested" for this project type. */
  craftbookTags: z.array(z.string()),
  /** Core and extended gezel-template recommendations for this project type. */
  gezelRoles: ProjectTypeGezelAffinitySchema,
});
export type ProjectType = z.infer<typeof ProjectTypeSchema>;

/**
 * The bundled seed taxonomy. Grows over time; the detector and partitioner
 * treat it purely as data, so adding an entry needs no code change.
 */
export const PROJECT_TYPES: ProjectType[] = [
  {
    id: 'browser-game',
    label: 'Browser Game',
    icon: 'die',
    description:
      'An interactive game that runs in the browser — HTML/Canvas, sprites, input loops.',
    detect: {
      extensions: ['html', 'js', 'ts', 'css'],
      keywords: [
        'game',
        'arcade',
        'sprite',
        'player',
        'shooter',
        'enemy',
        'score',
        'level',
        'collision',
        'canvas',
        'gameplay',
      ],
    },
    craftbookTags: [
      'game',
      'arcade',
      'puzzle',
      'idle',
      'incremental',
      'clicker',
      'game-jam',
      'micro-game',
      'board-game',
      'turn-based',
      'multiscreen',
      'physics',
      'simulation',
      'sprite',
      'game-art',
      'atlas',
    ],
    gezelRoles: {
      default: [
        {
          templateId: 'builder',
          reason: 'Owns the game from mechanics and code through a playable release.',
        },
      ],
      suggested: [
        { templateId: 'designer', reason: 'Shapes the game board, feedback, and visual language.' },
        { templateId: 'reviewer', reason: 'Tests gameplay, edge cases, and release quality.' },
      ],
    },
  },
  {
    id: 'web-app',
    label: 'Web App',
    icon: 'code',
    description: 'An interactive web application — components, routes, forms, an API it talks to.',
    detect: {
      extensions: ['tsx', 'jsx', 'ts', 'js', 'css', 'html', 'vue', 'svelte'],
      keywords: [
        'app',
        'dashboard',
        'login',
        'auth',
        'frontend',
        'react',
        'component',
        'form',
        'user',
        'spa',
      ],
    },
    craftbookTags: [
      'html',
      'website',
      'dashboard',
      'form',
      'pwa',
      'responsive',
      'accessibility',
      'a11y',
      'wcag',
      'api',
      'backend',
      'http',
      'seo',
      'performance',
      'bug-fix',
      'debugging',
      'tests',
      'quality',
    ],
    gezelRoles: {
      default: [
        {
          templateId: 'builder',
          reason: 'Owns the product flow from interface through implementation and release.',
        },
      ],
      suggested: [
        { templateId: 'designer', reason: 'Improves layout, hierarchy, and interaction quality.' },
        {
          templateId: 'reviewer',
          reason: 'Provides an independent quality and accessibility pass.',
        },
        {
          templateId: 'veiligheidsmeester',
          reason: 'Reviews authentication, data handling, dependencies, and attack surface.',
        },
      ],
    },
  },
  {
    id: 'static-site',
    label: 'Static Site',
    icon: 'globe',
    description:
      'A content-first website — landing pages, blog, marketing copy, mostly static HTML.',
    detect: {
      extensions: ['html', 'css', 'md', 'mdx', 'js'],
      keywords: ['website', 'landing', 'blog', 'marketing', 'seo', 'homepage', 'portfolio', 'docs'],
    },
    craftbookTags: [
      'website',
      'html',
      'landing-page',
      'hero',
      'seo',
      'responsive',
      'accessibility',
      'a11y',
      'wcag',
      'content',
      'marketing',
    ],
    gezelRoles: {
      default: [
        { templateId: 'builder', reason: 'Builds and ships the site as a coherent whole.' },
      ],
      suggested: [
        { templateId: 'designer', reason: 'Strengthens the visual system and responsive layout.' },
        { templateId: 'copywriter', reason: 'Sharpens the message for the intended reader.' },
        {
          templateId: 'reviewer',
          reason: 'Checks polish, accessibility, links, and release quality.',
        },
      ],
    },
  },
  {
    id: 'data-analysis',
    label: 'Data Analysis',
    icon: 'chart',
    description: 'Analysis of a dataset — notebooks, scripts, charts, reports, SQL.',
    detect: {
      extensions: ['py', 'ipynb', 'csv', 'tsv', 'r', 'sql', 'parquet'],
      keywords: [
        'data',
        'dataset',
        'analysis',
        'analytics',
        'pandas',
        'chart',
        'report',
        'statistics',
        'metrics',
        'visualization',
      ],
    },
    craftbookTags: [
      'data',
      'analysis',
      'etl',
      'pipeline',
      'sql',
      'visualization',
      'dashboard',
      'report',
      'reporting',
      'metrics',
      'kpi',
      'time-series',
      'finance',
    ],
    gezelRoles: {
      default: [
        {
          templateId: 'researcher',
          reason: 'Investigates the data and turns evidence into a substantive analysis.',
        },
      ],
      suggested: [
        { templateId: 'builder', reason: 'Builds repeatable analysis pipelines and deliverables.' },
        {
          templateId: 'reviewer',
          reason: 'Challenges assumptions, calculations, and conclusions.',
        },
      ],
    },
  },
  {
    id: 'api-service',
    label: 'API / Backend Service',
    icon: 'server',
    description: 'A server-side service — REST/GraphQL endpoints, a database, background jobs.',
    detect: {
      extensions: ['ts', 'js', 'py', 'go', 'rs', 'java', 'rb'],
      keywords: [
        'api',
        'endpoint',
        'rest',
        'graphql',
        'server',
        'backend',
        'openapi',
        'database',
        'microservice',
        'webhook',
      ],
    },
    craftbookTags: [
      'api',
      'backend',
      'rest',
      'http',
      'sdk',
      'schema',
      'integration',
      'security',
      'testing',
      'tests',
      'tdd',
      'bug-fix',
      'debugging',
      'dependencies',
      'migration',
    ],
    gezelRoles: {
      default: [
        { templateId: 'builder', reason: 'Owns the service from API shape through deployment.' },
      ],
      suggested: [
        { templateId: 'reviewer', reason: 'Checks contracts, failure modes, and test coverage.' },
        {
          templateId: 'veiligheidsmeester',
          reason: 'Reviews trust boundaries, secrets, dependencies, and exposed endpoints.',
        },
      ],
    },
  },
  {
    id: 'cli-tool',
    label: 'CLI / Tooling',
    icon: 'terminal',
    description: 'A command-line tool, script, or automation utility.',
    detect: {
      extensions: ['ts', 'js', 'py', 'go', 'rs', 'sh', 'bash'],
      keywords: ['cli', 'command', 'terminal', 'tool', 'script', 'automation', 'utility'],
    },
    craftbookTags: [
      'tooling',
      'automation',
      'script',
      'testing',
      'tests',
      'quality',
      'refactor',
      'bug-fix',
      'debugging',
      'tdd',
    ],
    gezelRoles: {
      default: [
        {
          templateId: 'builder',
          reason: 'Takes the tool from command design through distribution.',
        },
      ],
      suggested: [
        { templateId: 'reviewer', reason: 'Checks ergonomics, errors, portability, and tests.' },
        {
          templateId: 'veiligheidsmeester',
          reason: 'Reviews shell boundaries, filesystem access, inputs, and dependencies.',
        },
      ],
    },
  },
  {
    id: 'library',
    label: 'Library / SDK',
    icon: 'package',
    description: 'A reusable library, package, or SDK consumed by other code.',
    detect: {
      extensions: ['ts', 'js', 'py', 'go', 'rs'],
      keywords: ['library', 'package', 'sdk', 'module', 'npm', 'crate', 'gem'],
    },
    craftbookTags: [
      'library',
      'sdk',
      'documentation',
      'reference',
      'api',
      'testing',
      'tests',
      'tdd',
      'semver',
      'versioning',
      'changelog',
      'release',
      'release-notes',
      'refactor',
      'quality',
      'bug-fix',
      'debugging',
      'dependencies',
    ],
    gezelRoles: {
      default: [
        { templateId: 'builder', reason: 'Owns the public API, implementation, and release path.' },
      ],
      suggested: [
        { templateId: 'reviewer', reason: 'Checks API clarity, compatibility, tests, and docs.' },
        {
          templateId: 'veiligheidsmeester',
          reason: 'Audits dependency risk and unsafe public behavior before release.',
        },
      ],
    },
  },
  {
    id: 'content-writing',
    label: 'Writing / Content',
    icon: 'quill',
    description: 'Long-form writing — articles, docs, copy, newsletters.',
    detect: {
      extensions: ['md', 'mdx', 'txt', 'docx', 'rst'],
      keywords: [
        'article',
        'blog',
        'copy',
        'post',
        'essay',
        'documentation',
        'content',
        'newsletter',
        'writing',
      ],
    },
    craftbookTags: [
      'writing',
      'copywriting',
      'content',
      'document',
      'documentation',
      'long-form',
      'newsletter',
      'seo',
      'comms',
      'brief',
      'summary',
    ],
    gezelRoles: {
      default: [
        {
          templateId: 'copywriter',
          reason: 'Turns the brief into clear writing for real readers.',
        },
      ],
      suggested: [
        { templateId: 'researcher', reason: 'Finds and organizes the evidence behind the piece.' },
        {
          templateId: 'reviewer',
          reason: 'Provides a rigorous editorial and factual second pass.',
        },
        {
          templateId: 'schrijfmaat',
          reason: 'Supports sustained long-form and creative drafting.',
        },
      ],
    },
  },
  {
    id: 'media-production',
    label: 'Media Production',
    icon: 'camera',
    description: 'Audio, video, or image production — assets, captions, transcripts.',
    detect: {
      extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif', 'mp3', 'wav', 'mp4', 'mov'],
      modalities: ['image'],
      keywords: ['audio', 'video', 'podcast', 'image', 'design', 'asset', 'recording', 'clip'],
    },
    craftbookTags: [
      'audio',
      'video',
      'image',
      'images',
      'image-generation',
      'tts',
      'podcast',
      'narration',
      'transcription',
      'design',
      'branding',
      'vision',
      'ocr',
    ],
    gezelRoles: {
      default: [
        {
          templateId: 'designer',
          reason: 'Sets the visual direction and keeps the assets coherent.',
        },
      ],
      suggested: [
        { templateId: 'image-generator', reason: 'Produces image assets from a focused brief.' },
        { templateId: 'video-generator', reason: 'Produces video assets from a focused brief.' },
        {
          templateId: 'copywriter',
          reason: 'Develops scripts, captions, titles, and supporting copy.',
        },
      ],
    },
  },
  {
    id: 'design-prototype',
    label: 'Design / Prototype',
    icon: 'palette',
    description: 'A visual design or UI prototype — mockups, hero sections, branding.',
    detect: {
      extensions: ['html', 'css', 'svg', 'fig'],
      keywords: ['design', 'prototype', 'mockup', 'wireframe', 'ui', 'ux', 'branding'],
    },
    craftbookTags: [
      'design',
      'svg',
      'hero',
      'branding',
      'interactive',
      'responsive',
      'accessibility',
      'a11y',
      'wcag',
      'html',
      'canvas',
    ],
    gezelRoles: {
      default: [
        { templateId: 'designer', reason: 'Owns the concept, hierarchy, and visual direction.' },
      ],
      suggested: [
        { templateId: 'builder', reason: 'Turns the design into a working, testable prototype.' },
        { templateId: 'reviewer', reason: 'Checks usability, accessibility, and consistency.' },
      ],
    },
  },
  {
    // A public posting presence — the outbound half of social. Distinct from
    // 'email' (correspondence) and from the reserved 'messaging' slot below
    // (group chat): this one is about drafting, publishing, and reading the
    // reception of posts on feeds like Bluesky, X, Instagram, and LinkedIn.
    id: 'social-media',
    label: 'Social Media',
    icon: 'bubbles',
    description:
      'A public posting presence — drafting, approving, publishing, and reading reception across social feeds.',
    detect: {
      extensions: ['md', 'json', 'png', 'jpg'],
      keywords: [
        'social',
        'feed',
        'bluesky',
        'instagram',
        'linkedin',
        'followers',
        'engagement',
        'mentions',
        'caption',
        'hashtag',
        'repost',
      ],
    },
    // Tag audit note: 'writing'/'content' are deliberately NOT here — they'd
    // pull the whole long-form family (blog-post, documentation, 17 research
    // books) into the rail. 'social'/'post'/'digest'/'engagement' light up
    // exactly the feed books; 'copywriting' keeps thread/landing copy nearby.
    craftbookTags: ['social', 'post', 'digest', 'engagement', 'analytics', 'copywriting'],
    gezelRoles: {
      default: [
        {
          templateId: 'omroeper',
          reason: 'Runs the feed — drafts, queues, and reads the room.',
        },
      ],
      suggested: [
        { templateId: 'copywriter', reason: 'Sharpens the words when a post has to land.' },
        {
          templateId: 'image-generator',
          reason: 'Produces the visuals for media-first posts.',
        },
      ],
    },
  },
  {
    // Email specifically — thread/subject-centric, document-like correspondence.
    // Group chat (Slack/Telegram/Discord) is a distinct, future project type
    // ('messaging'): channel-centric, high-frequency, tiny messages that want a
    // different serialization granularity and different craftbooks.
    id: 'email',
    label: 'Email / Inbox',
    icon: 'envelope',
    description:
      'Email threads synced into the project — triage, drafting, summarizing, and correspondence.',
    detect: {
      extensions: ['md', 'eml'],
      modalities: ['email'],
      keywords: ['inbox', 'email', 'reply', 'thread', 'correspondence', 'triage', 'newsletter'],
    },
    craftbookTags: ['email', 'inbox-triage', 'triage', 'summary', 'brief', 'writing'],
    gezelRoles: {
      default: [
        {
          templateId: 'copywriter',
          reason: 'Drafts clear replies in the right voice and context.',
        },
      ],
      suggested: [
        { templateId: 'kantoormeester', reason: 'Keeps operational follow-ups from slipping.' },
        {
          templateId: 'researcher',
          reason: 'Investigates background before consequential replies.',
        },
      ],
    },
  },
  {
    // Tag audit note: 'pipeline'/'research'/'brief'/'weekly' are deliberately
    // NOT in craftbookTags — they'd pull devops pipelines, 17 research books,
    // and GTD noise into the suggestion rail. 'interview'/'offer'/'application'
    // are unused elsewhere and light up exactly the career books.
    id: 'job-hunt',
    label: 'Job Hunt',
    icon: 'briefcase',
    description:
      'A job-search campaign — tracked applications, tailored materials, interviews, offers.',
    detect: {
      extensions: ['md'],
      keywords: [
        'job',
        'career',
        'resume',
        'cv',
        'interview',
        'application',
        'recruiter',
        'offer',
        'hiring',
        'apply',
      ],
    },
    craftbookTags: ['career', 'job', 'resume', 'cv', 'interview', 'offer', 'application'],
    gezelRoles: {
      default: [
        {
          templateId: 'career-coach',
          reason: 'Runs the search as a campaign and keeps the application pipeline moving.',
        },
      ],
      suggested: [
        {
          templateId: 'mock-interviewer',
          reason: 'Provides realistic interview practice and feedback.',
        },
        { templateId: 'copywriter', reason: 'Tailors resumes, cover letters, and outreach.' },
      ],
    },
  },
];

/**
 * Taxonomy ids whose projects are codebases — a workspace of source files the
 * user (or a developer gezel) builds and runs, typically with a package
 * manifest and a toolchain. Developer-facing surfaces gate on this: the
 * chat/terminal compose switch in the project chat only appears for these
 * types (and only with "Show advanced features" on), so a writing or media
 * project never grows a shell prompt.
 */
export const CODING_PROJECT_TYPE_IDS: ReadonlySet<string> = new Set([
  'browser-game',
  'web-app',
  'static-site',
  'data-analysis',
  'api-service',
  'cli-tool',
  'library',
]);

/**
 * True when the project's effective type (explicit override first, then the
 * file-mix auto-detection) is one of the coding types. Unclassified projects
 * are NOT coding projects — the terminal and similar developer surfaces stay
 * hidden until a content-index scan actually sees code in the workspace.
 */
export function isCodingProject(p: {
  projectTypeId?: string;
  detectedProjectType?: { id: string };
}): boolean {
  const typeId = resolveProjectTypeId(p);
  return typeId !== undefined && CODING_PROJECT_TYPE_IDS.has(typeId);
}

/** Look up a project type by id. */
export function getProjectType(id: string | undefined | null): ProjectType | undefined {
  if (!id) return undefined;
  return PROJECT_TYPES.find((t) => t.id === id);
}

/** The full taxonomy, for UI listing (override dropdown). */
export function listProjectTypes(): ProjectType[] {
  return PROJECT_TYPES;
}
