import {
  type AppKnowledgeAction,
  AppKnowledgeActionSchema,
  type AppKnowledgeQuery,
  AppKnowledgeQuerySchema,
  type AppKnowledgeRetrieval,
  AppKnowledgeRetrievalSchema,
  type AppKnowledgeState,
  AppKnowledgeStateSchema,
} from '@bendyline/gezel-client/app-models';
import { GezelSdkError, errorFromResponse } from './errors.js';
import type { RequestOptions } from './types.js';

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
  async state(opts: RequestOptions = {}): Promise<AppKnowledgeState> {
    return AppKnowledgeStateSchema.parse(await this.request('state', undefined, opts));
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
  async retrieve(
    query: AppKnowledgeQuery,
    opts: RequestOptions = {},
  ): Promise<AppKnowledgeRetrieval> {
    const result = AppKnowledgeRetrievalSchema.parse(
      await this.request('retrieve', AppKnowledgeQuerySchema.parse(query), opts),
    );
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
