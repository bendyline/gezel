import { z } from 'zod';
import { FilePathSchema, LineNumberSchema } from './common.js';

export const ListDirectoryInputSchema = z.object({ path: z.string().optional() }).strict();
export const ReadDocumentInputSchema = z.object({ path: z.string() }).strict();
export const WriteDocumentInputSchema = z
  .object({ path: z.string(), content: z.string() })
  .strict();

export const ReadFileInputSchema = z
  .object({
    path: FilePathSchema,
    startLine: LineNumberSchema.optional().describe(
      '1-based first line to return (inclusive). Defaults to 1.',
    ),
    endLine: LineNumberSchema.optional().describe(
      '1-based last line to return (inclusive). Defaults to the end of the file.',
    ),
    raw: z
      .boolean()
      .optional()
      .describe('Return the file content without `N→` line-number gutters. Default false.'),
  })
  .strict();

export const WriteFileInputSchema = z
  .object({
    path: FilePathSchema.describe(
      'Exact workspace path relative to the project root. If the task names a path, pass that path exactly; do not prefix it with workspace/.',
    ),
    content: z.string().describe('Full file contents.'),
  })
  .strict();

export const AppendToFileInputSchema = z
  .object({
    path: FilePathSchema,
    content: z.string().describe('Text to append to the end of the file.'),
    create: z
      .boolean()
      .optional()
      .describe(
        'When true, create the file (with the given content as its only contents) if it does not yet exist. Default false — refuse to append to a missing file.',
      ),
  })
  .strict();

export const ReplaceInFileInputSchema = z
  .object({
    path: FilePathSchema,
    find: z
      .string()
      .min(1)
      .describe('Literal substring to find. No regex. Match is whitespace-exact.'),
    replace: z.string().describe('New content for the matched region. May be empty to delete.'),
    occurrence: z
      .union([z.number().int().positive(), z.literal('all')])
      .optional()
      .describe(
        "Default: exactly one match required. Pass a 1-based index for the Nth match, or 'all' to replace every occurrence.",
      ),
  })
  .strict();

export const ReplaceLinesInputSchema = z
  .object({
    path: FilePathSchema,
    startLine: z
      .number()
      .int()
      .positive()
      .describe('1-based first line to replace (inclusive). Read it from the read_file gutter.'),
    endLine: z
      .number()
      .int()
      .positive()
      .describe(
        '1-based last line to replace (inclusive). Equal to startLine to replace one line.',
      ),
    content: z
      .string()
      .describe('Replacement text for the range. Empty deletes the lines. No `N→` gutter.'),
  })
  .strict();

export const ListArtifactsInputSchema = z
  .object({
    path: z
      .string()
      .optional()
      .describe(
        'Subdirectory to walk (default: the whole artifacts root). Scopes recursive listings too. Do not include "artifacts/" — the call is already scoped there.',
      ),
    recursive: z
      .boolean()
      .optional()
      .describe(
        'Walk all subdirectories (default: true). Set to false for a single-level listing.',
      ),
  })
  .strict();

export const ReadArtifactInputSchema = z
  .object({
    path: z
      .string()
      .describe(
        'File path or basename. A redundant "artifacts/" prefix is stripped automatically.',
      ),
    startLine: LineNumberSchema.optional().describe(
      'Canonical 1-based first line to return (inclusive). Defaults to 1.',
    ),
    endLine: LineNumberSchema.optional().describe(
      'Canonical 1-based last line to return (inclusive). Defaults to the end of the file.',
    ),
  })
  .strict();

const StructuredContentSchema = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]);

/** Either `content` or `jsonContent` must be present; the executor enforces that. */
export const WriteArtifactInputSchema = z
  .object({
    path: z
      .string()
      .describe(
        'File path relative to the artifacts root (e.g. "summary.md" or "reports/summary.md"). Do NOT prefix with "artifacts/" — the call is already scoped there.',
      ),
    content: z
      .union([z.string(), StructuredContentSchema])
      .optional()
      .describe(
        'File text, or a structured object/array. Supply either content or jsonContent. Prefer jsonContent for JSON reports.',
      ),
    jsonContent: StructuredContentSchema.optional().describe(
      'Structured JSON object/array to serialize. Prefer this for .json reports and omit content. This separate field lets native model grammars enforce JSON structure.',
    ),
  })
  .strict();

export const ListDocumentsInputSchema = z
  .object({
    path: z.string().optional().describe('Subdirectory path to list (default: root)'),
    recursive: z.boolean().optional().describe('List all descendants (default: false)'),
  })
  .strict();
