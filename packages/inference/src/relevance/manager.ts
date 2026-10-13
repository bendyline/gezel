import {
  type GezelConfig,
  type RelevanceModelOverride,
  type RelevanceModelStatusResponse,
  type RelevanceScoreRequest,
  type RetrievalTraceSurface,
  createLogger,
  relevanceFromModelScore,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import type { ActiveRelevance, RelevanceStageProvider } from '../search/relevance-stage.js';
import { installRelevanceModel, installedRelevanceModel, removeRelevanceModel } from './install.js';
import { DEFAULT_RELEVANCE_MODEL_ID, RELEVANCE_MODELS, findRelevanceModel } from './registry.js';
import type { ResolvedRelevanceModel } from './relevance-core.js';
import { type RelevanceScorer, relevanceScorer } from './relevance-model.js';
import {
  type ResolvedRelevanceSetting,
  resolveRelevanceSetting,
  toResolvedModel,
} from './settings.js';

const log = createLogger('relevance');

/**
 * The relevance model's lifecycle: which one is selected, whether it is on
 * disk, downloading it on opt-in (only when the security policy allows app
 * network), warming it, and the status the Settings card and evals read.
 */
export class RelevanceModelManager implements RelevanceStageProvider {
  private job: {
    modelId: string;
    bytesDone: number;
    bytesTotal: number;
    error?: string;
  } | null = null;
  readonly scorer: RelevanceScorer;

  constructor(
    private readonly opts: {
      home: string;
      readConfig: () => Promise<GezelConfig | null>;
      scorer?: RelevanceScorer;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.scorer = opts.scorer ?? relevanceScorer();
  }

  async setting(): Promise<ResolvedRelevanceSetting> {
    return resolveRelevanceSetting(await this.opts.readConfig().catch(() => null));
  }

  /**
   * The model a surface should score with right now, or null when the
   * setting is off or the model is not installed. Never downloads.
   */
  async activeModel(): Promise<{
    setting: ResolvedRelevanceSetting;
    model: ResolvedRelevanceModel;
  } | null> {
    const setting = await this.setting();
    if (!setting.enabled || !setting.spec) return null;
    if (!(await installedRelevanceModel(this.opts.home, setting.spec))) return null;
    return { setting, model: toResolvedModel(this.opts.home, setting.spec) };
  }

  /**
   * What a retrieval surface scores with: the setting when that surface is on,
   * or a preview's override (which ignores the surface list and the switch).
   * Null when off or the model is not on disk — search never downloads.
   */
  async forSurface(
    surface: RetrievalTraceSurface,
    override?: RelevanceModelOverride,
  ): Promise<ActiveRelevance | null> {
    const setting = await this.setting();
    if (override && !override.enabled) return null;
    if (!override && (!setting.enabled || !setting.surfaces.has(surface))) return null;
    const spec = override
      ? findRelevanceModel(override.modelId ?? setting.spec?.id ?? DEFAULT_RELEVANCE_MODEL_ID)
      : setting.spec;
    if (!spec || !(await installedRelevanceModel(this.opts.home, spec))) return null;
    const thresholds =
      override?.thresholds !== undefined
        ? override.thresholds
        : spec.id === setting.spec?.id
          ? setting.thresholds
          : spec.thresholds;
    return {
      model: toResolvedModel(this.opts.home, spec),
      thresholds,
      budgetMs: override?.budgetMs ?? setting.budgets[surface],
      order: setting.order,
      knowledgeKeep: override?.knowledgeKeep ?? setting.knowledgeKeep,
    };
  }

  async status(): Promise<RelevanceModelStatusResponse> {
    const setting = await this.setting();
    const installed = new Set<string>();
    for (const spec of RELEVANCE_MODELS) {
      if (await installedRelevanceModel(this.opts.home, spec)) installed.add(spec.id);
    }
    const modelId = setting.spec?.id ?? '';
    const job = this.job?.modelId === modelId ? this.job : null;
    let status: RelevanceModelStatusResponse['status'];
    if (!setting.enabled) status = 'off';
    else if (job && !job.error) status = 'downloading';
    else if (!installed.has(modelId)) {
      status = (await this.networkAllowed()) ? 'not-installed' : 'blocked-network';
    } else status = this.scorer.status(modelId);
    return {
      enabled: setting.enabled,
      modelId,
      status,
      source: setting.source,
      ...(job && !job.error
        ? { progress: { bytesDone: job.bytesDone, bytesTotal: job.bytesTotal } }
        : {}),
      ...(job?.error ? { error: job.error } : {}),
      models: RELEVANCE_MODELS.map((spec) => ({
        id: spec.id,
        displayName: spec.displayName,
        description: spec.description,
        languages: spec.languages,
        approxBytes: spec.approxBytes,
        ...(spec.experimental ? { experimental: true } : {}),
        installed: installed.has(spec.id),
        calibrated: spec.thresholds !== null,
      })),
    };
  }

  /** Download a model in the background (network permitting), then warm it. */
  async install(
    modelId: string,
  ): Promise<{ started: boolean; installed?: boolean; reason?: string }> {
    const spec = findRelevanceModel(modelId);
    if (!spec) return { started: false, reason: `unknown relevance model ${modelId}` };
    if (await installedRelevanceModel(this.opts.home, spec)) {
      return { started: false, installed: true };
    }
    if (this.job && !this.job.error) return { started: this.job.modelId === modelId };
    if (!(await this.networkAllowed())) {
      return { started: false, reason: 'app network access is off in Security settings' };
    }
    this.job = { modelId, bytesDone: 0, bytesTotal: spec.approxBytes };
    void (async () => {
      const opts = this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {};
      for await (const event of installRelevanceModel(this.opts.home, spec, opts)) {
        if (event.type === 'progress' && this.job) {
          this.job.bytesDone = event.bytesDone;
          this.job.bytesTotal = event.bytesTotal;
        } else if (event.type === 'error' && this.job) {
          this.job.error = event.error;
          log.warn(`[relevance] install of ${modelId} failed: ${event.error}`);
          return;
        }
      }
      this.job = null;
      log.info(`[relevance] installed ${modelId}`);
      await this.scorer.warm(toResolvedModel(this.opts.home, spec));
    })().catch((err) => {
      if (this.job) this.job.error = err instanceof Error ? err.message : String(err);
    });
    return { started: true };
  }

  /** Bring the disk in line with the setting: install the selected model when it is on. */
  async reconcile(): Promise<void> {
    const setting = await this.setting();
    if (!setting.enabled || !setting.spec) return;
    if (await installedRelevanceModel(this.opts.home, setting.spec)) {
      void this.scorer.warm(toResolvedModel(this.opts.home, setting.spec));
      return;
    }
    await this.install(setting.spec.id);
  }

  /**
   * Deferred boot step: log what is resolved, then warm an installed, enabled
   * model — or download it when it is enabled but missing. New installs turn
   * the check on in first-run, which writes config without passing through
   * the Settings route that would otherwise start the download; so does a
   * download that failed or was interrupted last session. `install` keeps the
   * security policy's app-network gate.
   */
  async bootWarm(): Promise<void> {
    const setting = await this.setting();
    const installed = setting.spec
      ? await installedRelevanceModel(this.opts.home, setting.spec)
      : false;
    log.info(
      `[relevance] resolved enabled=${setting.enabled} model=${setting.spec?.id ?? 'none'} source=${setting.source} surfaces=${[...setting.surfaces].join(',')} installed=${installed}`,
    );
    if (!setting.enabled || !setting.spec) return;
    if (installed) {
      await this.scorer.warm(toResolvedModel(this.opts.home, setting.spec));
      return;
    }
    const started = await this.install(setting.spec.id);
    if (!started.started && !started.installed && started.reason) {
      log.info(`[relevance] not downloading ${setting.spec.id}: ${started.reason}`);
    }
  }

  async remove(modelId: string): Promise<boolean> {
    if (!findRelevanceModel(modelId)) return false;
    await removeRelevanceModel(this.opts.home, modelId);
    return true;
  }

  /** Raw scores for calibration: the bench's `/score` path. */
  async score(request: RelevanceScoreRequest) {
    const setting = await this.setting();
    const spec = findRelevanceModel(request.modelId ?? setting.spec?.id ?? '');
    if (!spec) return { error: `unknown relevance model ${request.modelId ?? ''}` } as const;
    if (!(await installedRelevanceModel(this.opts.home, spec))) {
      return { error: `${spec.id} is not installed` } as const;
    }
    const result = await this.scorer.score({
      model: toResolvedModel(this.opts.home, spec),
      query: request.query,
      passages: request.passages,
      budgetMs: 60_000,
      waitForLoad: request.waitForLoad ?? true,
    });
    const thresholds = setting.spec?.id === spec.id ? setting.thresholds : spec.thresholds;
    return {
      modelId: spec.id,
      status: result.status,
      ms: result.ms,
      scores: result.scores ?? [],
      relevances: (result.scores ?? []).map((score) =>
        score === null ? null : relevanceFromModelScore(score, thresholds),
      ),
    };
  }

  private async networkAllowed(): Promise<boolean> {
    const config = await this.opts.readConfig().catch(() => null);
    return config ? resolveSecurityPolicy(config).allowAppNetwork : true;
  }
}
