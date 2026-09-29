import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { transformersGraphOptions } from '@bendyline/gezel-knowledge';
import { PipelineLoadError } from '../memory/embed-core.js';

/**
 * Cross-encoder inference: load a pinned relevance model from its local
 * folder and score (query, passage) pairs. Runs inside the relevance worker
 * (or in-process under VITEST). Never touches the network — the model is
 * loaded with `local_files_only` from the folder `install.ts` verified.
 *
 * The text-classification PIPELINE is not usable here: it ignores
 * `text_pair` and softmaxes a single-logit head to 1.0, so every passage
 * would score the same. The tokenizer and model are called directly.
 */

const log = createLogger('relevance');

export interface ResolvedRelevanceModel {
  id: string;
  /** Absolute folder holding the repo layout (config.json, tokenizer.json, onnx/…). */
  dir: string;
  graph: string;
  graphSha256: string;
  maxTokens: number;
  queryMaxTokens: number;
  scoreActivation: 'sigmoid' | 'softmax-positive';
  intraOpNumThreads?: number;
}

interface Tensor {
  data: Float32Array | BigInt64Array | number[];
  dims: number[];
}

interface Tokenizer {
  (
    text: string[],
    opts: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },
  ): Record<string, Tensor>;
  encode(text: string, opts?: { add_special_tokens?: boolean; text_pair?: string }): number[];
  decode(ids: number[], opts?: { skip_special_tokens?: boolean }): string;
}

interface SequenceClassifier {
  (inputs: Record<string, Tensor>): Promise<{ logits: Tensor }>;
  sessions?: Record<string, { inputNames?: string[] }>;
  dispose?: () => Promise<unknown>;
}

/** Test seam: the two transformers.js classes this module uses. */
export interface RelevanceTransformers {
  AutoTokenizer: {
    from_pretrained(path: string, opts: Record<string, unknown>): Promise<Tokenizer>;
  };
  AutoModelForSequenceClassification: {
    from_pretrained(path: string, opts: Record<string, unknown>): Promise<SequenceClassifier>;
  };
}

interface LoadedRelevanceModel {
  tokenizer: Tokenizer;
  model: SequenceClassifier;
  /** Special tokens a (query, passage) pair costs. */
  pairOverhead: number;
  loadMs: number;
}

export interface RelevanceScoreOutcome {
  /** Activated 0–1 score per passage; null past the deadline. */
  scores: Array<number | null>;
  partial: boolean;
  truncatedPassages: number;
  inferMs: number;
}

const BATCH = 8;
const MAX_LOADED = 2;
const loaded = new Map<string, Promise<LoadedRelevanceModel>>();

async function importTransformers(): Promise<RelevanceTransformers> {
  return (await import('@huggingface/transformers')) as unknown as RelevanceTransformers;
}

export async function loadRelevanceModel(
  model: ResolvedRelevanceModel,
  transformers?: RelevanceTransformers,
): Promise<LoadedRelevanceModel> {
  const existing = loaded.get(model.id);
  if (existing) {
    loaded.delete(model.id);
    loaded.set(model.id, existing);
    return existing;
  }
  const promise = createRelevanceModel(model, transformers).catch((err) => {
    loaded.delete(model.id);
    throw err;
  });
  loaded.set(model.id, promise);
  while (loaded.size > MAX_LOADED) {
    const [oldest, oldPromise] = loaded.entries().next().value as [
      string,
      Promise<LoadedRelevanceModel>,
    ];
    loaded.delete(oldest);
    void oldPromise.then((old) => old.model.dispose?.()).catch(() => {});
  }
  return promise;
}

export function disposeRelevanceModels(): void {
  for (const promise of loaded.values()) {
    void promise.then((old) => old.model.dispose?.()).catch(() => {});
  }
  loaded.clear();
}

async function createRelevanceModel(
  model: ResolvedRelevanceModel,
  transformers?: RelevanceTransformers,
): Promise<LoadedRelevanceModel> {
  const started = performance.now();
  const graph = transformersGraphOptions(model.graph);
  if (!graph)
    throw new PipelineLoadError(`${model.id}: unusable graph ${model.graph}`, false, false);
  const actual = await sha256File(join(model.dir, model.graph)).catch(() => null);
  if (actual !== model.graphSha256) {
    throw new PipelineLoadError(
      `${model.id}: graph does not match its pin (expected ${model.graphSha256.slice(0, 12)}…, got ${actual?.slice(0, 12) ?? 'missing'}…)`,
      false,
      false,
    );
  }
  let lib: RelevanceTransformers;
  try {
    lib = transformers ?? (await importTransformers());
  } catch (err) {
    throw new PipelineLoadError(err instanceof Error ? err.message : String(err), true, false);
  }
  const local = { local_files_only: true };
  const tokenizer = await lib.AutoTokenizer.from_pretrained(model.dir, local);
  const classifier = await lib.AutoModelForSequenceClassification.from_pretrained(model.dir, {
    ...local,
    ...graph,
    session_options: { intraOpNumThreads: model.intraOpNumThreads ?? 2 },
  });
  const pairOverhead = tokenizer.encode('', { text_pair: '' }).length;
  const ready: LoadedRelevanceModel = {
    tokenizer,
    model: classifier,
    pairOverhead,
    loadMs: Math.round(performance.now() - started),
  };
  selfCheck(model, ready, await runBatch(model, ready, SELF_CHECK_QUERY, SELF_CHECK_PASSAGES));
  log.info(`[relevance] loaded ${model.id} in ${ready.loadMs}ms`);
  return ready;
}

const SELF_CHECK_QUERY = 'how long should coffee steep in a French press?';
const SELF_CHECK_PASSAGES = [
  'Let coarse ground coffee steep in hot water for about four minutes before pressing the plunger.',
  'The treaty ended an eleven-year border war between two duchies and settled a river toll.',
];

/**
 * A mis-wired pair encoding returns plausible, wrong scores — a BERT
 * cross-encoder that never sees segment ids still produces numbers. So the
 * model proves itself once at load: it must separate an obvious answer from
 * an obvious non-answer, and a graph that takes `token_type_ids` must get
 * them. Failure disables the model instead of letting it steer retrieval.
 */
function selfCheck(
  model: ResolvedRelevanceModel,
  ready: LoadedRelevanceModel,
  scores: number[],
): void {
  const inputs = ready.model.sessions?.model?.inputNames ?? [];
  if (inputs.includes('token_type_ids')) {
    const encoded = ready.tokenizer([SELF_CHECK_QUERY], {
      text_pair: [SELF_CHECK_PASSAGES[0]!],
      padding: true,
      truncation: true,
      max_length: model.maxTokens,
    });
    const types = encoded.token_type_ids?.data;
    const hasPassageSegment = types
      ? Array.from(types, Number).some((value) => value === 1)
      : false;
    if (!hasPassageSegment) {
      throw new PipelineLoadError(
        `${model.id}: pair encoding carries no passage segment`,
        false,
        false,
      );
    }
  }
  const [relevant, irrelevant] = scores;
  if (relevant === undefined || irrelevant === undefined || relevant <= irrelevant + 0.05) {
    throw new PipelineLoadError(
      `${model.id}: failed its self-check (relevant ${relevant?.toFixed(3)} vs irrelevant ${irrelevant?.toFixed(3)})`,
      false,
      false,
    );
  }
}

export async function scoreRelevancePairs(
  model: ResolvedRelevanceModel,
  query: string,
  passages: readonly string[],
  deadlineAt?: number,
  transformers?: RelevanceTransformers,
): Promise<RelevanceScoreOutcome> {
  const ready = await loadRelevanceModel(model, transformers);
  const started = performance.now();
  const scores: Array<number | null> = passages.map(() => null);
  let truncatedPassages = 0;
  let partial = false;
  const trimmedQuery = trimToTokens(ready.tokenizer, query, model.queryMaxTokens);
  const queryTokens = ready.tokenizer.encode(trimmedQuery, { add_special_tokens: false }).length;
  const passageBudget = Math.max(16, model.maxTokens - queryTokens - ready.pairOverhead - 2);
  for (let start = 0; start < passages.length; start += BATCH) {
    if (deadlineAt !== undefined && Date.now() > deadlineAt) {
      partial = true;
      break;
    }
    const batch = passages.slice(start, start + BATCH).map((passage) => {
      const trimmed = trimToTokens(ready.tokenizer, passage, passageBudget);
      if (trimmed !== passage) truncatedPassages++;
      return trimmed;
    });
    const batchScores = await runBatch(model, ready, trimmedQuery, batch);
    batchScores.forEach((score, i) => {
      scores[start + i] = score;
    });
  }
  return { scores, partial, truncatedPassages, inferMs: Math.round(performance.now() - started) };
}

async function runBatch(
  model: ResolvedRelevanceModel,
  ready: LoadedRelevanceModel,
  query: string,
  passages: readonly string[],
): Promise<number[]> {
  const inputs = ready.tokenizer(
    passages.map(() => query),
    { text_pair: [...passages], padding: true, truncation: true, max_length: model.maxTokens },
  );
  const { logits } = await ready.model(inputs);
  const values = Array.from(logits.data as ArrayLike<number>, Number);
  const labels = logits.dims[1] ?? 1;
  return passages.map((_, row) => {
    const rowLogits = values.slice(row * labels, row * labels + labels);
    return activate(rowLogits, model.scoreActivation);
  });
}

export function activate(
  logits: readonly number[],
  activation: 'sigmoid' | 'softmax-positive',
): number {
  if (activation === 'sigmoid' || logits.length === 1) return 1 / (1 + Math.exp(-(logits[0] ?? 0)));
  const max = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp(logit - max));
  return (exps[1] ?? 0) / exps.reduce((sum, value) => sum + value, 0);
}

/**
 * Bound a text to `maxTokens` WITHOUT the special tokens, so the tokenizer's
 * own truncation — which cuts the tail and would drop the closing separator
 * of a pair — never has to act. A character cap first keeps tokenization of a
 * huge passage cheap.
 */
function trimToTokens(tokenizer: Tokenizer, text: string, maxTokens: number): string {
  const capped = text.length > maxTokens * 6 ? text.slice(0, maxTokens * 6) : text;
  const ids = tokenizer.encode(capped, { add_special_tokens: false });
  if (ids.length <= maxTokens) return capped;
  return tokenizer.decode(ids.slice(0, maxTokens), { skip_special_tokens: true });
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
