import {
  type AppKnowledgeAction,
  AppKnowledgeActionSchema,
  type AppKnowledgeQuery,
  AppKnowledgeQuerySchema,
  type AppKnowledgeRelevance,
  AppKnowledgeRelevanceSchema,
  type AppKnowledgeRetrieval,
  AppKnowledgeRetrievalSchema,
  type AppKnowledgeState,
  AppKnowledgeStateSchema,
} from '@bendyline/gezel-client/app-models';
import { GezelSdkError, errorFromResponse } from './errors.js';
import type { RequestOptions } from './types.js';

/** What `retrieve` takes. `rerank` defaults to `auto`. */
export type KnowledgeRetrieveInput = Omit<AppKnowledgeQuery, 'rerank'> & {
  rerank?: AppKnowledgeQuery['rerank'];
};

/** Catalog state, plus the one thing an app may offer to improve results. */
export interface KnowledgeState extends AppKnowledgeState {
  /**
   * A one-time model download that ranks passages better. Offered while a
   * catalog is enabled and the relevance model is missing; null when it is
   * installed, cannot be downloaded here, or no catalog would use it. Start it
   * with `update({ action: 'prepare-reranker' })`; `downloading` while it runs.
   * Name it for people as better results, never as a reranker.
   */
  improvement: {
    downloadBytes: number;
    downloading: boolean;
    percent: number | null;
  } | null;
}

/** Narrow catalog authority. Never accepts file paths, URLs, or project IDs. */
export class KnowledgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch,
  ) {}
  private async request(
    path: string,
    body: unknown | undefined,
    opts: RequestOptions,
  ): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}/v1/knowledge/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: opts.signal,
    });
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body)
      throw new GezelSdkError('Knowledge response has no body', {
        code: 'invalid_response',
      });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4 * 1024 * 1024)
          throw new GezelSdkError('Knowledge response exceeds the budget', {
            code: 'invalid_response',
          });
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  /** Set once a Gezel rejects `rerank: 'auto'`; it predates the mode. */
  private autoUnsupported = false;

  async state(opts: RequestOptions = {}): Promise<KnowledgeState> {
    const [raw, relevance] = await Promise.all([
      this.request('state', undefined, opts),
      this.relevance(opts),
    ]);
    const state = AppKnowledgeStateSchema.parse(raw);
    const used = state.catalogs.some(
      (catalog) => catalog.enabled && catalog.installedVersion !== null,
    );
    return {
      ...state,
      improvement:
        used && relevance && !relevance.ready && relevance.downloadBytes !== null
          ? {
              downloadBytes: relevance.downloadBytes,
              downloading: relevance.downloading,
              percent: relevance.percent,
            }
          : null,
    };
  }

  /**
   * Null from a Gezel that predates the route — a 404, or the UI shell's HTML
   * when that Gezel serves its interface for unknown paths. The offer is
   * optional, so no failure here may fail `state()`.
   */
  private async relevance(opts: RequestOptions): Promise<AppKnowledgeRelevance | null> {
    try {
      return AppKnowledgeRelevanceSchema.parse(await this.request('relevance', undefined, opts));
    } catch {
      opts.signal?.throwIfAborted();
      return null;
    }
  }
  async update(action: AppKnowledgeAction, opts: RequestOptions = {}): Promise<void> {
    const result = await this.request('update', AppKnowledgeActionSchema.parse(action), opts);
    if (
      typeof result !== 'object' ||
      result === null ||
      Object.keys(result).length !== 1 ||
      (result as { ok?: unknown }).ok !== true
    )
      throw new GezelSdkError('Invalid knowledge update response', {
        code: 'invalid_response',
      });
  }
  /**
   * Reference passages for a query. `auto` (the default) ranks them with the
   * relevance model when it is installed, and otherwise returns only what
   * Gezel's own bar for unranked passages admits — never an error for the
   * missing model. `required` refuses without it.
   */
  async retrieve(
    input: KnowledgeRetrieveInput,
    opts: RequestOptions = {},
  ): Promise<AppKnowledgeRetrieval> {
    const query = AppKnowledgeQuerySchema.parse({ ...input, rerank: input.rerank ?? 'auto' });
    if (query.rerank === 'auto' && this.autoUnsupported)
      return this.retrieveLegacyAuto(query, opts);
    try {
      return await this.send(query, opts);
    } catch (error) {
      // The query passed this schema, so an older Gezel can only be rejecting
      // `auto` (422 from the daemon, 400 from some transports).
      if (
        query.rerank === 'auto' &&
        error instanceof GezelSdkError &&
        (error.status === 400 || error.status === 422)
      ) {
        this.autoUnsupported = true;
        return this.retrieveLegacyAuto(query, opts);
      }
      throw error;
    }
  }

  /** `auto` against a Gezel that only knows `required`: no model, no passages. */
  private async retrieveLegacyAuto(
    query: AppKnowledgeQuery,
    opts: RequestOptions,
  ): Promise<AppKnowledgeRetrieval> {
    try {
      return await this.send({ ...query, rerank: 'required' }, opts);
    } catch (error) {
      if (error instanceof GezelSdkError && error.code === 'reranker_required')
        return { reranked: false, passages: [] };
      throw error;
    }
  }

  private async send(
    query: AppKnowledgeQuery,
    opts: RequestOptions,
  ): Promise<AppKnowledgeRetrieval> {
    const result = AppKnowledgeRetrievalSchema.parse(await this.request('retrieve', query, opts));
    if (query.rerank === 'required' && !result.reranked)
      throw new GezelSdkError('Knowledge passages were not ranked', {
        code: 'invalid_response',
      });
    if (
      result.passages.reduce((total, passage) => total + passage.text.length, 0) >
      query.maxCharacters
    )
      throw new GezelSdkError('Knowledge passages exceed the requested budget', {
        code: 'invalid_response',
      });
    return result;
  }
}
