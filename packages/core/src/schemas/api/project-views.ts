import { z } from 'zod';
import { FileMapScopeSchema } from './file-map.js';

// Wire shapes for the project Views tab's data: the dependency graph a
// Diagram lays out, and the one-file insight the shared inspector shows.

const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

/** code: imports and includes; docs: document links; all: both. */
export const FileGraphKindSchema = z.enum(['code', 'docs', 'all']);
export type FileGraphKind = z.infer<typeof FileGraphKindSchema>;

export const FileGraphRequestSchema = z.object({
  kind: FileGraphKindSchema.optional(),
  /** Test files: `core` leaves them out (default), `tests` keeps only them, `all` keeps both. */
  scope: FileMapScopeSchema.optional(),
  /** Node cap (default 500, at most 2000). The busiest files are kept. */
  max: z.coerce.number().int().positive().max(2000).optional(),
  /** Keep this file and everything within `hops` of it, whatever the cap. */
  focus: z.string().min(1).optional(),
  hops: z.coerce.number().int().min(1).max(3).optional(),
});
export type FileGraphRequest = z.infer<typeof FileGraphRequestSchema>;

export const FileGraphNodeSchema = z.object({
  /** The file's project-relative path. */
  id: z.string(),
  label: z.string(),
  folder: z.string(),
  lang: z.string().nullable(),
  modality: z.string().nullable(),
  use: z.enum(['code', 'data', 'config', 'style']).nullable(),
  test: z.boolean(),
  loc: z.number().int().nonnegative(),
  fanIn: z.number().int().nonnegative(),
  fanOut: z.number().int().nonnegative(),
  /** Import-graph centrality, 0..1 (PageRank, max-normalized). */
  importance: z.number().min(0).max(1),
  findings: z.number().int().nonnegative(),
  maxSeverity: SeveritySchema.nullable(),
  /** Commits in the churn window, when git history is available. */
  churn: z.number().int().nonnegative().optional(),
  /** The opening of the file's summary, when the index has one. */
  lead: z.string().optional(),
});
export type FileGraphNode = z.infer<typeof FileGraphNodeSchema>;

export const FileGraphEdgeSchema = z.object({
  /** The file that depends (imports, includes, links). */
  source: z.string(),
  target: z.string(),
  kind: z.enum(['import', 'include', 'link']),
  /** Named bindings taken, first 8. */
  names: z.array(z.string()),
  nameCount: z.number().int().nonnegative(),
  /** Erased at compile time (`import type`). */
  typeOnly: z.boolean(),
  /** Loaded lazily (`import()`). */
  dynamic: z.boolean(),
  /** A re-export, as a barrel file does. */
  reexport: z.boolean(),
});
export type FileGraphEdge = z.infer<typeof FileGraphEdgeSchema>;

export const FileGraphFolderSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  /** Files in this folder and below that are in the graph. */
  fileCount: z.number().int().nonnegative(),
  /** The index's summary of what the folder is for, when one exists. */
  purpose: z.string().optional(),
});
export type FileGraphFolder = z.infer<typeof FileGraphFolderSchema>;

export const FileGraphCoverageSchema = z.object({
  files: z.number().int().nonnegative(),
  filesWithImports: z.number().int().nonnegative(),
  filesWithEdges: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
});

export const FileGraphResponseSchema = z.object({
  indexed: z.boolean(),
  builtAt: z.string(),
  kind: FileGraphKindSchema,
  scope: FileMapScopeSchema,
  /** false before the index has resolved its graph (only relative imports are known). */
  resolved: z.boolean(),
  /** The walk that fed the graph hit its file cap. */
  partial: z.boolean(),
  nodes: z.array(FileGraphNodeSchema),
  edges: z.array(FileGraphEdgeSchema),
  /** Packages outside the project a file imports (JS/TS): `{ from, pkg }`. */
  externals: z.array(z.object({ from: z.string(), pkg: z.string() })),
  folders: z.array(FileGraphFolderSchema),
  /** Folders holding a package manifest, named as the manifest names them. */
  packageRoots: z.array(z.object({ folder: z.string(), name: z.string() })),
  /** Per language: how much of it the graph can draw. */
  coverage: z.record(z.string(), FileGraphCoverageSchema),
  /** Changes only when nodes or edges change; a layout keyed on it can be reused. */
  signature: z.string(),
  /** What the cap left out, when it left out anything. */
  truncated: z
    .object({ nodes: z.number().int().nonnegative(), edges: z.number().int().nonnegative() })
    .nullable(),
});
export type FileGraphResponse = z.infer<typeof FileGraphResponseSchema>;

// ── one file, for the inspector ──────────────────────────────────────────

const FileConnectionSchema = z.object({
  path: z.string(),
  /** Names the importer takes; empty for a whole-file import or a link. */
  names: z.array(z.string()),
});

export const FileInsightResponseSchema = z.object({
  path: z.string(),
  /** false when the path is not in the index (not scanned yet, or ignored). */
  indexed: z.boolean(),
  file: z
    .object({
      size: z.number().nonnegative().nullable(),
      mtimeMs: z.number().nullable(),
      lang: z.string().nullable(),
      kind: z.string().nullable(),
      modality: z.string().nullable(),
      use: z.enum(['code', 'data', 'config', 'style']).nullable(),
      loc: z.number().int().nonnegative().nullable(),
      trivial: z.boolean(),
    })
    .nullable(),
  summary: z.object({ text: z.string(), lead: z.string() }).nullable(),
  /** The nearest folder the index has summarized, and what it says it is for. */
  folder: z.object({
    path: z.string(),
    purpose: z.string().optional(),
    purposePath: z.string().optional(),
  }),
  /** Photo facts, for images. A location is never included. */
  media: z
    .object({
      takenAt: z.string().optional(),
      cameraMake: z.string().optional(),
      cameraModel: z.string().optional(),
      lens: z.string().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      screenshot: z.boolean().optional(),
    })
    .optional(),
  /** A markdown document's title and frontmatter. */
  doc: z
    .object({ title: z.string().optional(), frontmatter: z.record(z.string(), z.string()) })
    .optional(),
  git: z
    .object({ commits: z.number().int().nonnegative(), lastCommitAt: z.string().optional() })
    .optional(),
  connections: z.object({
    imports: z.array(FileConnectionSchema),
    importedBy: z.array(FileConnectionSchema),
    links: z.array(FileConnectionSchema),
    linkedFrom: z.array(FileConnectionSchema),
    /** Other paths with exactly this content. */
    duplicates: z.array(z.string()),
    truncated: z.boolean(),
  }),
  findings: z.object({
    count: z.number().int().nonnegative(),
    maxSeverity: SeveritySchema.nullable(),
  }),
});
export type FileInsightResponse = z.infer<typeof FileInsightResponseSchema>;

// ── reports, for the Reports view ────────────────────────────────────────

/** What a report is about, from where it lives in the artifacts drawer. */
export const ProjectReportKindSchema = z.enum([
  'codebase',
  'map',
  'issues',
  'documents',
  'photos',
  'review',
  'digest',
  'other',
]);
export type ProjectReportKind = z.infer<typeof ProjectReportKindSchema>;

/** The reports Gezel can write on request, without a model. */
export const WritableReportKindSchema = z.enum([
  'codebase',
  'map',
  'issues',
  'documents',
  'photos',
]);
export type WritableReportKind = z.infer<typeof WritableReportKindSchema>;

export const ProjectReportSchema = z.object({
  /** Path in the project's artifacts drawer. */
  path: z.string(),
  title: z.string(),
  kind: ProjectReportKindSchema,
  mtimeMs: z.number(),
  size: z.number().int().nonnegative(),
  /** Suggested actions written into it (gezel-action blocks). */
  actions: z.number().int().nonnegative(),
});
export type ProjectReport = z.infer<typeof ProjectReportSchema>;

export const ProjectReportsResponseSchema = z.object({
  /** Newest first. */
  reports: z.array(ProjectReportSchema),
  /** The reports this project's folder suits, in the order to offer them. */
  writable: z.array(WritableReportKindSchema),
  /** More reports exist than were listed. */
  truncated: z.boolean(),
});
export type ProjectReportsResponse = z.infer<typeof ProjectReportsResponseSchema>;

export const GenerateProjectReportRequestSchema = z.object({ kind: WritableReportKindSchema });
export type GenerateProjectReportRequest = z.infer<typeof GenerateProjectReportRequestSchema>;

export const GenerateProjectReportResponseSchema = z.object({
  /** The report now on disk; null when there was nothing to write about. */
  path: z.string().nullable(),
  /** False when the report was already up to date or there was nothing to say. */
  wrote: z.boolean(),
});
export type GenerateProjectReportResponse = z.infer<typeof GenerateProjectReportResponseSchema>;

// ── the gallery, for the Gallery view ────────────────────────────────────

/** How the gallery forms its shelves. `event` is a photo library's outings. */
export const GalleryGroupSchema = z.enum(['type', 'folder', 'event']);
export type GalleryGroup = z.infer<typeof GalleryGroupSchema>;

/** Which families of files to show (see core's `ruleFileType`). */
export const GalleryFilterSchema = z.enum(['all', 'photos', 'documents', 'data', 'media', 'code']);
export type GalleryFilter = z.infer<typeof GalleryFilterSchema>;

export const GalleryRequestSchema = z.object({
  /** Defaults by what the folder holds: outings for pictures, folders for code, types otherwise. */
  group: GalleryGroupSchema.optional(),
  filter: GalleryFilterSchema.optional(),
  /** Words every shown file must contain, in its path, title, type or summary. */
  q: z.string().max(200).optional(),
  /** Shelves to return (default 12). */
  shelves: z.coerce.number().int().positive().max(200).optional(),
  /** Items per shelf (default 24). */
  perShelf: z.coerce.number().int().positive().max(200).optional(),
});
export type GalleryRequest = z.infer<typeof GalleryRequestSchema>;

export const GalleryItemSchema = z.object({
  path: z.string(),
  name: z.string(),
  /** `ruleFileType` id: `photo`, `slides`, `code:typescript`, … */
  type: z.string(),
  typeLabel: z.string(),
  family: z.enum(['photos', 'documents', 'data', 'media', 'code', 'other']),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
  /** A photo's capture time, `YYYY-MM-DDTHH:MM:SS` as the camera recorded it. */
  takenAt: z.string().optional(),
  /** A document's title: its frontmatter title or first heading. */
  title: z.string().optional(),
  /** The opening of the index's summary (a photo's description). */
  lead: z.string().optional(),
});
export type GalleryItem = z.infer<typeof GalleryItemSchema>;

export const GalleryShelfSchema = z.object({
  /** Stable across requests with the same group: `type:photo`, `folder:src`, `event:…`, `copies`. */
  id: z.string(),
  label: z.string(),
  /** One line under the label: what the folder is for, what a special shelf holds. */
  description: z.string().optional(),
  /** Where the label came from: a rule, the folder's path, or the photos' dates. */
  labelSource: z.enum(['rule', 'path', 'date']),
  count: z.number().int().nonnegative(),
  items: z.array(GalleryItemSchema),
});
export type GalleryShelf = z.infer<typeof GalleryShelfSchema>;

export const GalleryResponseSchema = z.object({
  indexed: z.boolean(),
  /** The grouping used: the request's, or the folder's default. */
  group: GalleryGroupSchema,
  /** The groupings this folder supports, in the order to offer them. */
  groups: z.array(GalleryGroupSchema),
  filter: GalleryFilterSchema,
  /** Files per family before the filter, for the filter keys. */
  families: z.record(z.string(), z.number().int().nonnegative()),
  /** Files the filter and words kept. */
  total: z.number().int().nonnegative(),
  shelves: z.array(GalleryShelfSchema),
  /** Shelves in all; more than `shelves.length` means more can be asked for. */
  shelfCount: z.number().int().nonnegative(),
});
export type GalleryResponse = z.infer<typeof GalleryResponseSchema>;

export const GalleryShelfRequestSchema = z.object({
  group: GalleryGroupSchema,
  filter: GalleryFilterSchema.optional(),
  q: z.string().max(200).optional(),
  shelf: z.string().min(1),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export type GalleryShelfRequest = z.infer<typeof GalleryShelfRequestSchema>;

export const GalleryShelfResponseSchema = z.object({
  shelf: z.string(),
  offset: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  items: z.array(GalleryItemSchema),
});
export type GalleryShelfResponse = z.infer<typeof GalleryShelfResponseSchema>;

// ── the timeline, for the Timeline view ──────────────────────────────────

export const TimelineBucketSizeSchema = z.enum(['week', 'month', 'year']);
export type TimelineBucketSize = z.infer<typeof TimelineBucketSizeSchema>;

export const TimelineRequestSchema = z.object({
  /** Defaults by how long the history runs: weeks for months, months for years. */
  bucket: TimelineBucketSizeSchema.optional(),
});
export type TimelineRequest = z.infer<typeof TimelineRequestSchema>;

/** A row of the timeline: an area of the project (git) or a family of files. */
export const TimelineLaneSchema = z.object({ id: z.string(), label: z.string() });
export type TimelineLane = z.infer<typeof TimelineLaneSchema>;

export const TimelineBucketSchema = z.object({
  /** First day in it, `YYYY-MM-DD` in the machine's time zone. */
  start: z.string(),
  /** The day after its last, `YYYY-MM-DD`. */
  end: z.string(),
  /** "Week of October 13, 2026", "October 2026", "2026". */
  label: z.string(),
  /** Commits in it; 0 when the timeline reads file dates. */
  commits: z.number().int().nonnegative(),
  /** Files changed in it (git), or dated in it (file dates). */
  files: z.number().int().nonnegative(),
  /** Per lane id: file changes (git) or files (file dates). */
  lanes: z.record(z.string(), z.number().int().nonnegative()),
});
export type TimelineBucket = z.infer<typeof TimelineBucketSchema>;

export const TimelineResponseSchema = z.object({
  indexed: z.boolean(),
  /** `git`: the project's commits. `files`: each file at its own date (a photo when taken). */
  source: z.enum(['git', 'files']),
  bucket: TimelineBucketSizeSchema,
  lanes: z.array(TimelineLaneSchema),
  /** Oldest first, every bucket between the first and the last, empty ones included. */
  buckets: z.array(TimelineBucketSchema),
  /** The history runs further back than the buckets returned. */
  truncated: z.boolean(),
});
export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;

const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const TimelineBucketRequestSchema = z.object({
  start: LocalDateSchema,
  end: LocalDateSchema,
  /** The timeline's own source, so the detail matches the bars; git when history exists. */
  source: z.enum(['git', 'files']).optional(),
});
export type TimelineBucketRequest = z.infer<typeof TimelineBucketRequestSchema>;

export const TimelineCommitSchema = z.object({
  sha: z.string(),
  at: z.string(),
  subject: z.string(),
  /** The files it changed that the timeline shows, first 12. */
  files: z.array(z.string()),
  fileCount: z.number().int().nonnegative(),
});
export type TimelineCommit = z.infer<typeof TimelineCommitSchema>;

export const TimelineFileSchema = GalleryItemSchema.extend({
  /** Commits in the range that changed it (git). */
  changes: z.number().int().nonnegative().optional(),
});
export type TimelineFile = z.infer<typeof TimelineFileSchema>;

export const TimelineBucketResponseSchema = z.object({
  start: z.string(),
  end: z.string(),
  source: z.enum(['git', 'files']),
  /** Newest first. */
  commits: z.array(TimelineCommitSchema),
  /** Most changed first (git), newest first (file dates). */
  files: z.array(TimelineFileSchema),
  /** More commits or files than were listed. */
  truncated: z.boolean(),
});
export type TimelineBucketResponse = z.infer<typeof TimelineBucketResponseSchema>;
