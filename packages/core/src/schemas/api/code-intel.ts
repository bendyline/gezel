import { z } from 'zod';
import { FileReviewIssueSeveritySchema, FileReviewWireSchema } from '../file-review.js';

// ── code-intel (workspace code intelligence) ────────────────────────────────
// Every result carries 1-based inclusive line ranges so the model's next move
// is a precise `read_file(path, { startLine, endLine })` — see the plan's
// "shared result conventions".

export const CodeSymbolSchema = z.object({
  /** Stable id `path#name` for multi-step flows. */
  id: z.string(),
  name: z.string(),
  /** function | method | class | interface | type | enum | h1..h6 | … */
  kind: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  signature: z.string().optional(),
  /** Enclosing container (e.g. the class a method belongs to). */
  parent: z.string().optional(),
});
export type CodeSymbol = z.infer<typeof CodeSymbolSchema>;

export const OutlineFileRequestSchema = z.object({
  path: z.string().min(1),
});
export type OutlineFileRequest = z.infer<typeof OutlineFileRequestSchema>;

export const OutlineFileResponseSchema = z.object({
  path: z.string(),
  lang: z.string().nullable(),
  summary: z.string().nullable().optional(),
  symbols: z.array(CodeSymbolSchema),
  totalLines: z.number().int().nonnegative(),
  /** index = from the persisted index; live = extracted on demand. */
  engine: z.enum(['index', 'live', 'unavailable']),
  truncated: z.boolean(),
  /** Boekwachter review for this file@hash; absent until the review pass ran. */
  review: FileReviewWireSchema.optional(),
});
export type OutlineFileResponse = z.infer<typeof OutlineFileResponseSchema>;

export const FindSymbolRequestSchema = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),
  maxResults: z.number().int().positive().max(200).optional(),
});
export type FindSymbolRequest = z.infer<typeof FindSymbolRequestSchema>;

export const FindSymbolResponseSchema = z.object({
  matches: z.array(CodeSymbolSchema.extend({ path: z.string() })),
  truncated: z.boolean(),
  engine: z.enum(['index', 'unavailable']),
});
export type FindSymbolResponse = z.infer<typeof FindSymbolResponseSchema>;

export const ReadSymbolRequestSchema = z.object({
  name: z.string().min(1),
  /** Disambiguate when the same name is defined in several files. */
  path: z.string().optional(),
});
export type ReadSymbolRequest = z.infer<typeof ReadSymbolRequestSchema>;

export const ReadSymbolResponseSchema = z.object({
  found: z.boolean(),
  path: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  signature: z.string().optional(),
  source: z.string().optional(),
});
export type ReadSymbolResponse = z.infer<typeof ReadSymbolResponseSchema>;

export const FindReferencesRequestSchema = z.object({
  name: z.string().min(1),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().max(500).optional(),
});
export type FindReferencesRequest = z.infer<typeof FindReferencesRequestSchema>;

export const FindReferencesResponseSchema = z.object({
  references: z.array(
    z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() }),
  ),
  truncated: z.boolean(),
  /** v1 is lexical (identifier match), labelled honestly. */
  engine: z.enum(['ripgrep', 'javascript']),
});
export type FindReferencesResponse = z.infer<typeof FindReferencesResponseSchema>;

// ── file-context (per-symbol intelligence for the file viewer) ──────────────
// Structured FACTS only — hosts (the Map file viewer, the vscode extension)
// compose their own markdown from these via `composeFileContext` in
// core/src/code-intel. Dependency attribution is honest about its limits:
// symbol-level inbound comes from named import bindings (JS/TS; best-effort
// Python); default/namespace/unrecorded imports count as whole-file.

export const FileContextRequestSchema = z.object({
  path: z.string().min(1),
});
export type FileContextRequest = z.infer<typeof FileContextRequestSchema>;

export const FileContextFindingSchema = z.object({
  ruleId: z.string(),
  category: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  /** 1-based line, null when whole-file. */
  line: z.number().int().positive().nullable(),
  title: z.string(),
  source: z.string(),
});
export type FileContextFinding = z.infer<typeof FileContextFindingSchema>;

export const FileContextImporterSchema = z.object({
  path: z.string(),
  /** True when the importer names this symbol explicitly; false = whole-file
   *  (namespace/default import, or a language without recorded bindings). */
  viaBinding: z.boolean(),
});
export type FileContextImporter = z.infer<typeof FileContextImporterSchema>;

export const SymbolContextSchema = z.object({
  name: z.string(),
  kind: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  signature: z.string().optional(),
  parent: z.string().optional(),
  importedBy: z.array(FileContextImporterSchema),
  importedByTruncated: z.boolean(),
  /** Imported bindings lexically referenced inside this symbol's range. */
  uses: z.array(
    z.object({
      /** Local identifier as referenced in this file. */
      name: z.string(),
      /** Repo-relative path when resolved in-repo, else the raw package specifier. */
      from: z.string(),
      inRepo: z.boolean(),
    }),
  ),
  /** Sibling symbols in this file whose ranges lexically reference this name. */
  usedInFileBy: z.array(z.string()),
  findings: z.array(FileContextFindingSchema),
  /** LLM one-liner; absent until enrichment has covered this file@hash. */
  summary: z.string().optional(),
});
export type SymbolContext = z.infer<typeof SymbolContextSchema>;

export const FileContextResponseSchema = z.object({
  path: z.string(),
  lang: z.string().nullable(),
  totalLines: z.number().int().nonnegative(),
  /** File-level LLM summary (same row outline-file surfaces), when enriched. */
  summary: z.string().nullable(),
  importedBy: z.array(
    z.object({
      path: z.string(),
      /** Exported names the importer takes ([] = whole-file import only). */
      names: z.array(z.string()),
    }),
  ),
  importedByTruncated: z.boolean(),
  imports: z.array(
    z.object({
      specifier: z.string(),
      /** Repo-relative resolved target, null when external/unresolved. */
      resolvedPath: z.string().nullable(),
      names: z.array(z.string()),
      default: z.boolean(),
      namespace: z.boolean(),
    }),
  ),
  /** Findings outside every symbol range (incl. line-less findings). */
  fileFindings: z.array(FileContextFindingSchema),
  symbols: z.array(SymbolContextSchema),
  symbolsTruncated: z.boolean(),
  /** index = persisted index; live = symbols extracted on demand; unavailable = no index. */
  engine: z.enum(['index', 'live', 'unavailable']),
  /** Boekwachter review for this file@hash; absent until the review pass ran. */
  review: FileReviewWireSchema.optional(),
});
export type FileContextResponse = z.infer<typeof FileContextResponseSchema>;

// ── file reviews (boekwachter cliffs notes + issues + health) ───────────────

export const FileReviewRequestSchema = z.object({
  path: z.string().min(1),
});
export type FileReviewRequest = z.infer<typeof FileReviewRequestSchema>;

export const FileReviewResponseSchema = z.object({
  path: z.string(),
  found: z.boolean(),
  /** True when the file is indexed but its current hash has no review yet. */
  pending: z.boolean().optional(),
  review: FileReviewWireSchema.optional(),
  /**
   * False when no rubric covers this file's kind — it will NEVER be reviewed,
   * as opposed to `pending` ("not yet"). Absent on found responses and on
   * older daemons.
   */
  eligible: z.boolean().optional(),
});
export type FileReviewResponse = z.infer<typeof FileReviewResponseSchema>;

export const ListFileIssuesRequestSchema = z.object({
  severity: FileReviewIssueSeveritySchema.optional(),
  category: z.string().optional(),
  /** Repo-relative path prefix filter. */
  path: z.string().optional(),
  maxResults: z.number().int().positive().max(1000).optional(),
});
export type ListFileIssuesRequest = z.infer<typeof ListFileIssuesRequestSchema>;

export const ListFileIssuesResponseSchema = z.object({
  issues: z.array(
    z.object({
      path: z.string(),
      severity: FileReviewIssueSeveritySchema,
      category: z.string(),
      message: z.string(),
      line: z.number().int().positive().optional(),
    }),
  ),
  counts: z.object({
    total: z.number().int().nonnegative(),
    bySeverity: z.record(z.string(), z.number().int().nonnegative()),
    byCategory: z.record(z.string(), z.number().int().nonnegative()),
  }),
  truncated: z.boolean(),
  indexed: z.boolean(),
  /** Coverage denominators — "3 issues across 40/312 reviewed files" reads
   *  very differently from "3 issues"; keep the tool honest mid-sweep. */
  reviewedFiles: z.number().int().nonnegative(),
  eligibleFiles: z.number().int().nonnegative(),
  /** Distinct reviewer identities over the filtered set (provenance line). */
  reviewers: z
    .array(
      z.object({
        model: z.string().nullable(),
        provider: z.string().nullable(),
        gezelName: z.string().nullable(),
        files: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
export type ListFileIssuesResponse = z.infer<typeof ListFileIssuesResponseSchema>;

export const MapRepoRequestSchema = z.object({
  path: z.string().optional(),
});
export type MapRepoRequest = z.infer<typeof MapRepoRequestSchema>;

export const MapRepoResponseSchema = z.object({
  root: z.string(),
  languages: z.array(z.object({ lang: z.string(), fileCount: z.number().int().nonnegative() })),
  areas: z.array(
    z.object({
      path: z.string(),
      fileCount: z.number().int().nonnegative(),
      purpose: z.string().optional(),
    }),
  ),
  entryPoints: z.array(z.string()),
  keyFiles: z.array(z.string()),
  fileCount: z.number().int().nonnegative(),
  /** false when the index hasn't been built yet (areas/languages may be empty). */
  indexed: z.boolean(),
  /** Project-level architecture note from the deep-pass rollup, when generated. */
  architecture: z.string().optional(),
  /** Review-pass rollup (aggregates only); omitted until any file is reviewed. */
  health: z
    .object({
      reviewedFiles: z.number().int().nonnegative(),
      eligibleFiles: z.number().int().nonnegative(),
      /** Mean 1-10 health across reviewed files, one decimal. */
      avgHealth: z.number(),
      majorIssues: z.number().int().nonnegative(),
      minorIssues: z.number().int().nonnegative(),
      worstFiles: z
        .array(
          z.object({
            path: z.string(),
            health: z.number().int().min(1).max(10),
            reason: z.string().optional(),
          }),
        )
        .max(5),
    })
    .optional(),
});
export type MapRepoResponse = z.infer<typeof MapRepoResponseSchema>;
