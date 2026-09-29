import { z } from 'zod';

/**
 * A relevance model: a small cross-encoder that reads a query and a passage
 * together and scores how well the passage answers the query. Unlike the
 * relevance the search arms report — derived from RANK, so the top of any
 * arm always looks strong — this score is absolute, which is what lets a
 * surface drop what is off-topic and inject nothing when nothing fits.
 *
 * A spec pins every file by sha256 at an exact revision, so what runs is
 * byte-for-byte what was evaluated. Thresholds come from the retrieval bench
 * (evals/src/retrieval-bench), never from guesswork: a spec with no
 * calibration can reorder results but can never drop one.
 */

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const RelevanceModelFileSchema = z.object({
  /** Repository-relative path, forward slashes. */
  path: z
    .string()
    .min(1)
    .regex(/^(?!\/)(?!.*\.\.)[\w./-]+$/),
  sha256: Sha256Schema,
  bytes: z.number().int().positive(),
});
export type RelevanceModelFile = z.infer<typeof RelevanceModelFileSchema>;

/** Scores in the model's activated space at which a surface drops, keeps, or calls a hit strong. */
export const RelevanceThresholdsSchema = z
  .object({
    drop: z.number(),
    keep: z.number(),
    strong: z.number(),
  })
  .refine((t) => t.drop < t.keep && t.keep < t.strong, {
    message: 'thresholds must satisfy drop < keep < strong',
  });
export type RelevanceThresholds = z.infer<typeof RelevanceThresholdsSchema>;

export const RelevanceModelSpecSchema = z.object({
  /** Storage key and setting value. A new id for ANY change to the pin. */
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*@\d+$/),
  displayName: z.string().min(1),
  /** Plain-language description for the Settings picker. */
  description: z.string().min(1),
  source: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    /** The upstream model a port was converted from, whose license applies. */
    upstream: z.string().optional(),
  }),
  license: z.object({ spdx: z.string().min(1), url: z.string().url() }),
  /** BCP-47 tags, or `multilingual`. */
  languages: z.array(z.string().min(1)).min(1),
  /** transformers.js sequence-classification `model_type`. */
  architecture: z.enum(['bert', 'xlm-roberta', 'deberta-v2', 'roberta', 'electra', 'distilbert']),
  files: z.array(RelevanceModelFileSchema).min(1),
  /** The ONNX graph to run; must be one of `files`. */
  graph: z.string().min(1),
  approxBytes: z.number().int().positive(),
  /** The model's total token budget for query + passage + specials. */
  maxTokens: z.number().int().positive(),
  /** Queries are trimmed to this many tokens; the rest of `maxTokens` is the passage's. */
  queryMaxTokens: z.number().int().positive(),
  /** How raw logits become a score: one logit through a sigmoid, or softmax over two. */
  scoreActivation: z.enum(['sigmoid', 'softmax-positive']),
  thresholds: RelevanceThresholdsSchema.nullable(),
  calibration: z
    .object({
      measuredAt: z.string(),
      /** The bench report the thresholds came from. */
      evalRun: z.string(),
    })
    .nullable(),
  /** Hidden from the Settings picker; selectable by id for evals. */
  experimental: z.boolean().optional(),
});
export type RelevanceModelSpec = z.infer<typeof RelevanceModelSpecSchema>;

export const RELEVANCE_MODEL_STATUSES = [
  'off',
  'not-installed',
  'downloading',
  'cold',
  'warming',
  'ready',
  'blocked-network',
  'unavailable',
  'disabled',
] as const;
export type RelevanceModelStatus = (typeof RELEVANCE_MODEL_STATUSES)[number];

/** `GET /api/relevance-model` — the Settings card and the evals read this. */
export interface RelevanceModelStatusResponse {
  enabled: boolean;
  modelId: string;
  status: RelevanceModelStatus;
  /** Where the setting came from: an eval env override, config, or the default. */
  source: 'env' | 'config' | 'default';
  progress?: { bytesDone: number; bytesTotal: number };
  error?: string;
  models: Array<
    Pick<
      RelevanceModelSpec,
      'id' | 'displayName' | 'description' | 'languages' | 'approxBytes' | 'experimental'
    > & { installed: boolean; calibrated: boolean }
  >;
}

export const RelevanceScoreRequestSchema = z.object({
  modelId: z.string().optional(),
  query: z.string().min(1).max(4_000),
  passages: z.array(z.string().max(20_000)).min(1).max(64),
  /** Wait for the model to load instead of answering `cold`. */
  waitForLoad: z.boolean().optional(),
});
export type RelevanceScoreRequest = z.infer<typeof RelevanceScoreRequestSchema>;
