import { z } from 'zod';

/**
 * Prompt-pack benchmark contract.
 *
 * A *task pack* is a program, owned by the product whose work it measures,
 * that knows what to test: fixtures, the product's own request builders and
 * reply readers, deterministic checks, and judge rubrics. The harness
 * (`evals/src/docbench/`) owns everything else: models and engines, trial
 * daemons, judging, statistics and publishing. They meet only through these
 * shapes, over a process boundary:
 *
 * - `<pack> describe` prints a {@link BenchPackManifest};
 * - `<pack> run --endpoint … --model … --out-dir …` writes one
 *   {@link BenchCaseOutcome} per case and reports progress as
 *   `[bench-event] {json}` lines on stdout ({@link BenchEvent}).
 *
 * The first pack is DocBlocks' docbench (`@bendyline/docblocks-bench`), whose
 * `src/contract.ts` is the TypeScript side of this contract. Change both
 * together; bump {@link BENCH_PACK_SCHEMA_VERSION} on a breaking change.
 */

export const BENCH_PACK_SCHEMA_VERSION = 1;

const Id = z.string().min(1).max(120);
const Fraction = z.number().min(0).max(1);

export const BenchFamilySchema = z.object({
  id: Id,
  label: z.string().min(1),
  weight: Fraction,
});
export type BenchFamily = z.infer<typeof BenchFamilySchema>;

export const BenchJudgeAxisSchema = z.object({
  id: Id,
  label: z.string().min(1),
  description: z.string().min(1),
});
export type BenchJudgeAxis = z.infer<typeof BenchJudgeAxisSchema>;

/**
 * How a case is judged. `rubric`: each axis scored 0–10. `matcher`: the judge
 * matches output items against an answer key and labels each item; the
 * harness computes recall, precision and F1 from the labels.
 */
export const BenchJudgeSpecSchema = z.object({
  rubricId: Id,
  mode: z.enum(['rubric', 'matcher']),
  axes: z.array(BenchJudgeAxisSchema),
  vision: z.boolean().optional(),
  matchWeight: Fraction.optional(),
  /** Matcher only: also label each item's complexity, and weight recall by key `level`. */
  levels: z.boolean().optional(),
  instructions: z.string().min(1),
});
export type BenchJudgeSpec = z.infer<typeof BenchJudgeSpecSchema>;

export const BenchTaskInfoSchema = z.object({
  id: Id,
  family: Id,
  label: z.string().min(1),
  description: z.string(),
  trials: z.number().int().min(1).max(20),
  scoring: z.object({ checks: Fraction, judge: Fraction }),
  /** Weight within its family; 1 when absent. */
  weight: z.number().positive().optional(),
  judge: BenchJudgeSpecSchema.nullable(),
  cases: z.array(z.object({ id: Id, label: z.string() })).min(1),
});
export type BenchTaskInfo = z.infer<typeof BenchTaskInfoSchema>;

export const BenchPackManifestSchema = z.object({
  schemaVersion: z.literal(BENCH_PACK_SCHEMA_VERSION),
  id: Id,
  version: z.string().min(1),
  /** The fixture set (`public`, or a swapped-in holdout) and a hash of its content. */
  fixtures: z.object({ id: Id, sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).optional(),
  families: z.array(BenchFamilySchema).min(1),
  tasks: z.array(BenchTaskInfoSchema).min(1),
});
export type BenchPackManifest = z.infer<typeof BenchPackManifestSchema>;

export const BenchCheckSchema = z.object({
  id: Id,
  label: z.string(),
  score: Fraction,
  weight: z.number().min(0),
  detail: z.string().optional(),
});
export type BenchCheck = z.infer<typeof BenchCheckSchema>;

export const BenchArtifactSchema = z.object({
  kind: z.enum(['markdown', 'json', 'svg', 'text']),
  content: z.string(),
});
export type BenchArtifact = z.infer<typeof BenchArtifactSchema>;

/**
 * How much a fix takes: `low` mechanical (typo, punctuation, number format),
 * `medium` rewording a sentence, `high` paragraph or document level (buried
 * point, contradiction, missing definition, structure).
 */
export const BenchComplexitySchema = z.enum(['low', 'medium', 'high']);
export type BenchComplexity = z.infer<typeof BenchComplexitySchema>;
export const BENCH_COMPLEXITIES: readonly BenchComplexity[] = ['low', 'medium', 'high'];

export const BenchAnswerKeyItemSchema = z.object({
  id: Id,
  quote: z.string().optional(),
  issue: z.string().min(1),
  level: BenchComplexitySchema.optional(),
});
export type BenchAnswerKeyItem = z.infer<typeof BenchAnswerKeyItemSchema>;

export const BenchJudgeInputSchema = z.object({
  rubricId: Id,
  context: z.string(),
  answerKey: z.array(BenchAnswerKeyItemSchema).optional(),
  items: z.array(z.object({ id: Id, text: z.string() })).optional(),
  reference: z.string().optional(),
});
export type BenchJudgeInput = z.infer<typeof BenchJudgeInputSchema>;

const TokenCount = z.number().int().min(0).nullable();

export const BenchCallSchema = z.object({
  promptTokens: TokenCount,
  completionTokens: TokenCount,
  finishReason: z.enum(['stop', 'length', 'cancelled', 'error']),
  ms: z.number().min(0),
  engineMaxTokens: z.number().int().min(0).optional(),
});
export type BenchCall = z.infer<typeof BenchCallSchema>;

export const BenchCaseOutcomeSchema = z.object({
  schemaVersion: z.literal(BENCH_PACK_SCHEMA_VERSION),
  packVersion: z.string().min(1),
  taskId: Id,
  caseId: Id,
  trial: z.number().int().min(0),
  seed: z.number().int().nullable(),
  model: z.string().min(1),
  contextWindow: z.number().int().positive().nullable(),
  usable: z.boolean(),
  checks: z.array(BenchCheckSchema),
  artifact: BenchArtifactSchema.nullable(),
  judgeInput: BenchJudgeInputSchema.nullable(),
  calls: z.array(BenchCallSchema),
  /** `infra`: the endpoint failed; the case says nothing about the model. */
  error: z.object({ class: z.enum(['model', 'infra']), message: z.string() }).nullable(),
  notes: z.array(z.string()),
  ms: z.number().min(0),
});
export type BenchCaseOutcome = z.infer<typeof BenchCaseOutcomeSchema>;

export const BenchEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    model: z.string(),
    contextWindow: z.number().nullable(),
    cases: z.number().int().min(0),
  }),
  z.object({ type: z.literal('case-start'), taskId: Id, caseId: Id }),
  z.object({
    type: z.literal('case-done'),
    taskId: Id,
    caseId: Id,
    usable: z.boolean(),
    error: z.enum(['model', 'infra']).nullable(),
    ms: z.number().min(0),
    file: z.string().min(1),
  }),
  z.object({ type: z.literal('done'), cases: z.number().int().min(0), ms: z.number().min(0) }),
]);
export type BenchEvent = z.infer<typeof BenchEventSchema>;

export const BENCH_EVENT_PREFIX = '[bench-event] ';

/** A progress event from one stdout line, or null for any other line. */
export function parseBenchEventLine(line: string): BenchEvent | null {
  if (!line.startsWith(BENCH_EVENT_PREFIX)) return null;
  try {
    const parsed = BenchEventSchema.safeParse(JSON.parse(line.slice(BENCH_EVENT_PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
