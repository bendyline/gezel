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
