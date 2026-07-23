import { z } from 'zod';
import { CraftbookSchema } from './craftbook.js';

/**
 * ─ Project-local store schemas ──────────────────────────────────────
 *
 * These describe the files that live in a project's workspace `.gezel/`
 * folder — the authored, repo-travelling half of the project-local
 * gezel/craftbook feature. See `packages/core/src/project-local-id.ts`
 * for the id codec and `paths.ts` (`projectLocal*`) for the on-disk
 * locations.
 */

/** Which workspace-root instruction file feeds the `@project` gezel's prompt. */
export const InstructionSourceFileSchema = z.enum([
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
]);
export type InstructionSourceFile = z.infer<typeof InstructionSourceFileSchema>;

/**
 * How multiple instruction files are combined into the `@project` prompt.
 *   - `primary` (default): the highest-precedence present file wins
 *     verbatim; lower files are ignored (recorded as superseded). Avoids
 *     contradictory merged system prompts.
 *   - `concat`: join present files in precedence order under
 *     `## Source: <file>` headers.
 */
export const InstructionMergeModeSchema = z.enum(['primary', 'concat']);
export type InstructionMergeMode = z.infer<typeof InstructionMergeModeSchema>;

/**
 * `.gezel/project.json` — a thin about-source MAPPING for the canonical
 * `@project` gezel, NOT an identity store. The gezel's identity (name,
 * gender, voice, role, poppetje) lives in `.gezel/gezels/project/gezel.md`
 * + app-data; its `about` (system prompt) is read live from `sourceFile`
 * at the workspace root, so the instruction file stays the source of
 * truth. `aboutHash` lets the indexer detect when the file changed.
 */
export const ProjectLocalConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  sourceFile: InstructionSourceFileSchema.optional(),
  mergeMode: InstructionMergeModeSchema.optional(),
  aboutHash: z.string().optional(),
  derivedAt: z.string().optional(),
});
export type ProjectLocalConfig = z.infer<typeof ProjectLocalConfigSchema>;

/** Provenance for the auto-imported `@project` gezel. */
export const ImportedGezelProvenanceSchema = z.object({
  /** sha256 of the instruction file contents the gezel was last derived from. */
  hash: z.string(),
  /** Which instruction file won precedence. */
  sourceFile: InstructionSourceFileSchema,
  mergeMode: InstructionMergeModeSchema.optional(),
  /** Encoded gezel id (`proj__<projectId>__project`). */
  gezelId: z.string(),
  /**
   * Set true once the user edits the gezel's identity in the UI. The sync
   * engine then stops touching identity (the `about` is always file-driven
   * regardless).
   */
  userEdited: z.boolean().optional(),
});
export type ImportedGezelProvenance = z.infer<typeof ImportedGezelProvenanceSchema>;

/**
 * Provenance for mirroring the repo's instruction file (AGENTS.md/
 * CLAUDE.md/copilot) into the project's `about.md`. Tracked at the top
 * level — independent of the (now-deprecated) `@project` gezel — so the
 * About merge keeps working for projects that never mint one. Lets the
 * sync rewrite the imported block only when the file changes, and
 * back-fill projects imported before the merge existed.
 */
export const ImportedAboutProvenanceSchema = z.object({
  /** sha256 of the instruction content last merged into `about.md`. */
  hash: z.string(),
  /** Which instruction file the merged content came from. */
  sourceFile: z.string(),
});
export type ImportedAboutProvenance = z.infer<typeof ImportedAboutProvenanceSchema>;

/** Provenance for one skill→craftbook import. */
export const ImportedCraftbookProvenanceSchema = z.object({
  /** sha256 of the SKILL.md body the craftbook was last derived from. */
  hash: z.string(),
  /** Project-local craftbook id this skill produced. */
  craftbookId: z.string(),
  /** Generated JS script names attached to the craftbook (if any). */
  scriptNames: z.array(z.string()).default([]),
  /** True once the user edits the imported craftbook; sync stops clobbering it. */
  userEdited: z.boolean().optional(),
});
export type ImportedCraftbookProvenance = z.infer<typeof ImportedCraftbookProvenanceSchema>;

/**
 * `.gezel/imports.json` — the provenance ledger the sync engine reads to
 * stay idempotent and avoid clobbering user edits. Keyed by the skill's
 * workspace-relative `source` path for craftbooks.
 */
export const ImportProvenanceSchema = z.object({
  version: z.literal(1).default(1),
  gezel: ImportedGezelProvenanceSchema.optional(),
  about: ImportedAboutProvenanceSchema.optional(),
  craftbooks: z.record(z.string(), ImportedCraftbookProvenanceSchema).default({}),
});
export type ImportProvenance = z.infer<typeof ImportProvenanceSchema>;

/** One bash→JS translation awaiting user review before it is written to disk. */
export const PendingScriptSchema = z.object({
  /** Script file name (without `.ts`). */
  name: z.string(),
  /** Translated gezel-sdk TypeScript body. */
  body: z.string(),
  /** Translator self-reported confidence, 0–1. Static conversions are 1. */
  confidence: z.number().min(0).max(1),
  /** The original shell snippet, for the reviewer to compare against. */
  sourceBlock: z.string(),
  /** Who produced the translation. Absent on legacy items = 'llm'. */
  origin: z.enum(['static', 'llm']).optional(),
});
export type PendingScript = z.infer<typeof PendingScriptSchema>;

/**
 * A persona the source skill embodies ("You are a YC office hours
 * partner…"). Approval is the consent moment: the gezel is created only
 * when the user approves the import, never at index time.
 */
export const PendingPersonaSchema = z.object({
  role: z.string(),
  /** Generator-shaped about.md body (Identity section from the skill's intro). */
  about: z.string(),
});
export type PendingPersona = z.infer<typeof PendingPersonaSchema>;

/** One skill's pending import proposal (craftbook draft + generated scripts). */
export const PendingImportItemSchema = z.object({
  /** Workspace-relative SKILL.md path this proposal came from. */
  skillSource: z.string(),
  /** sha256 of the raw skill body + companion-file list — lets sync skip an unchanged, still-pending skill. */
  sourceHash: z.string(),
  /** Draft craftbook to write on approval. */
  craftbook: CraftbookSchema,
  /** Generated scripts to write on approval (empty when prose-only). */
  scripts: z.array(PendingScriptSchema).default([]),
  /** Persona to mint on approval (persona-shaped skills only). */
  persona: PendingPersonaSchema.optional(),
  /** Converter honesty ledger — features of the source skill not carried over. */
  notes: z.array(z.string()).optional(),
  createdAt: z.string(),
});
export type PendingImportItem = z.infer<typeof PendingImportItemSchema>;

/** `.gezel/pending-imports.json` — review-before-save queue for generated JS. */
export const PendingImportsSchema = z.object({
  version: z.literal(1).default(1),
  items: z.array(PendingImportItemSchema).default([]),
});
export type PendingImports = z.infer<typeof PendingImportsSchema>;
