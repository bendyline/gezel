import { availableParallelism } from 'node:os';
import {
  type GezelConfig,
  KNOWLEDGE_FILTER_MIN_RELEVANCE,
  type RelevanceModelSpec,
  type RelevanceThresholds,
  type RetrievalTraceSurface,
} from '@bendyline/gezel';
import { relevanceModelDir } from './install.js';
import { DEFAULT_RELEVANCE_MODEL_ID, findRelevanceModel } from './registry.js';
import type { ResolvedRelevanceModel } from './relevance-core.js';

/**
 * The single owner of "is the relevance model on, which one, and how is it
 * used". Precedence: eval env override → config → off. Evals drive every
 * lever through the env so an arm never needs a config write:
 *
 *   GEZEL_RELEVANCE_MODEL       off | on | <model id>
 *   GEZEL_RELEVANCE_SURFACES    turn,references,search
 *   GEZEL_RELEVANCE_THRESHOLDS  drop,keep,strong   (activated-score space)
 *   GEZEL_RELEVANCE_BUDGET_MS   turn:250,references:700,search:400
 *   GEZEL_RELEVANCE_KNOWLEDGE_KEEP  0.5   (relevance space; knowledge on filter surfaces)
 *   GEZEL_RELEVANCE_ORDER       weighted | flat
 */

export interface ResolvedRelevanceSetting {
  enabled: boolean;
  spec: RelevanceModelSpec | null;
  source: 'env' | 'config' | 'default';
  surfaces: ReadonlySet<RetrievalTraceSurface>;
  /** Null when the model is uncalibrated: it may reorder, never drop. */
  thresholds: RelevanceThresholds | null;
  budgets: Record<RetrievalTraceSurface, number>;
  /** `flat`: order by model relevance across corpora instead of weighted score. */
  order: 'weighted' | 'flat';
  /** Relevance a knowledge passage needs to survive a filter surface. */
  knowledgeKeep: number;
}

const DEFAULT_BUDGETS: Record<RetrievalTraceSurface, number> = {
  turn: 250,
  references: 700,
  search: 400,
};

const ALL_SURFACES: RetrievalTraceSurface[] = ['turn', 'references', 'search'];

export function resolveRelevanceSetting(
  config: Pick<GezelConfig, 'relevanceModel'> | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRelevanceSetting {
  const envModel = env.GEZEL_RELEVANCE_MODEL?.trim();
  let enabled = config?.relevanceModel?.enabled === true;
  let modelId = config?.relevanceModel?.modelId ?? DEFAULT_RELEVANCE_MODEL_ID;
  let source: ResolvedRelevanceSetting['source'] = config?.relevanceModel ? 'config' : 'default';
  if (envModel) {
    source = 'env';
    if (envModel === 'off') enabled = false;
    else {
      enabled = true;
      if (envModel !== 'on') modelId = envModel;
    }
  }
  const spec = findRelevanceModel(modelId);
  const surfaces = new Set(
    (env.GEZEL_RELEVANCE_SURFACES?.split(',') ?? ALL_SURFACES)
      .map((s) => s.trim())
      .filter((s): s is RetrievalTraceSurface => (ALL_SURFACES as string[]).includes(s)),
  );
  return {
    enabled: enabled && spec !== null,
    spec,
    source,
    surfaces,
    thresholds: parseThresholds(env.GEZEL_RELEVANCE_THRESHOLDS) ?? spec?.thresholds ?? null,
    budgets: { ...DEFAULT_BUDGETS, ...parseBudgets(env.GEZEL_RELEVANCE_BUDGET_MS) },
    order: env.GEZEL_RELEVANCE_ORDER === 'flat' ? 'flat' : 'weighted',
    knowledgeKeep: parseUnit(env.GEZEL_RELEVANCE_KNOWLEDGE_KEEP) ?? KNOWLEDGE_FILTER_MIN_RELEVANCE,
  };
}

function parseUnit(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function parseThresholds(raw: string | undefined): RelevanceThresholds | null {
  if (!raw) return null;
  const [drop, keep, strong] = raw.split(',').map(Number);
  if ([drop, keep, strong].some((v) => v === undefined || !Number.isFinite(v))) return null;
  if (!(drop! < keep! && keep! < strong!)) return null;
  return { drop: drop!, keep: keep!, strong: strong! };
}

function parseBudgets(raw: string | undefined): Partial<Record<RetrievalTraceSurface, number>> {
  const out: Partial<Record<RetrievalTraceSurface, number>> = {};
  for (const part of raw?.split(',') ?? []) {
    const [surface, value] = part.split(':');
    const ms = Number(value);
    if (surface && (ALL_SURFACES as string[]).includes(surface) && Number.isFinite(ms) && ms > 0) {
      out[surface as RetrievalTraceSurface] = ms;
    }
  }
  return out;
}

/** What the scorer needs to load a spec from its installed folder. */
export function toResolvedModel(home: string, spec: RelevanceModelSpec): ResolvedRelevanceModel {
  const graph = spec.files.find((file) => file.path === spec.graph)!;
  return {
    id: spec.id,
    dir: relevanceModelDir(home, spec.id),
    graph: spec.graph,
    graphSha256: graph.sha256,
    maxTokens: spec.maxTokens,
    queryMaxTokens: spec.queryMaxTokens,
    scoreActivation: spec.scoreActivation,
    intraOpNumThreads: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
  };
}
