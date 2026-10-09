import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { GezelClient, createTrustingFetch } from '@bendyline/gezel-client/node';

export type InterventionSource = 'fixture' | 'user-request' | 'simulated-user' | 'evaluator';
export interface Intervention {
  at: string;
  source: InterventionSource;
  reason: string;
  method: string;
  target: string | null;
  payloadHash: string;
  promptHash?: string;
  status: 'attempted' | 'delivered' | 'blocked' | 'failed' | 'unanswered';
}

export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
}

/** The default is evaluator: a new scenario cannot accidentally bypass the boundary. */
export class QualificationBoundary {
  private readonly origin = new AsyncLocalStorage<{ source: InterventionSource; reason: string }>();
  readonly interventions: Intervention[] = [];
  readonly usedScriptEntries = new Set<number>();
  readonly observedQuestions = new Set<string>();

  constructor(
    readonly runDir: string,
    readonly repairPolicy: 'runtime' | 'harness',
  ) {}

  run<T>(source: InterventionSource, reason: string, fn: () => T): T {
    return this.origin.run({ source, reason }, fn);
  }

  record(event: Omit<Intervention, 'at'>): void {
    const record = { at: new Date().toISOString(), ...event };
    this.interventions.push(record);
    appendFileSync(join(this.runDir, 'interventions.jsonl'), `${JSON.stringify(record)}\n`);
  }

  private readonly clients = new WeakMap<GezelClient, GezelClient>();

  client(connection: {
    client: GezelClient;
    baseUrl: string;
    token: string;
    cert: string | null;
  }): GezelClient {
    let client = this.clients.get(connection.client);
    if (!client) {
      client = new GezelClient({
        baseUrl: connection.baseUrl,
        token: connection.token,
        fetch: this.observeFetch(
          connection.cert ? createTrustingFetch({ cert: connection.cert }) : fetch,
        ),
      });
      this.clients.set(connection.client, client);
    }
    return client;
  }

  /** All client surfaces, including nested helpers and raw uploads, use this fetch. */
  observeFetch(baseFetch: typeof fetch): typeof fetch {
    return async (input, init) => {
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return baseFetch(input, init);
      const path = new URL(request?.url ?? String(input)).pathname;
      const origin = this.origin.getStore() ?? {
        source: 'evaluator' as const,
        reason: 'undeclared-scenario-action',
      };
      // Hash payloads only; never inspect or serialize authorization headers.
      const body = init?.body ?? (request ? await request.clone().text() : undefined);
      let message: unknown;
      if (typeof body === 'string') {
        try {
          const parsed = JSON.parse(body);
          message = parsed.message ?? parsed.text;
        } catch {
          /* binary/form payload */
        }
      }
      const event = {
        ...origin,
        method,
        target: path,
        payloadHash: digest(body),
        ...(typeof message === 'string' ? { promptHash: digest(message) } : {}),
      };
      if (origin.source === 'evaluator' && this.repairPolicy === 'runtime') {
        this.record({ ...event, status: 'blocked' });
        throw new Error(`Qualification blocked evaluator mutation: ${method} ${path}`);
      }
      this.record({ ...event, status: 'attempted' });
      try {
        const response = await baseFetch(input, init);
        this.record({ ...event, status: response.ok ? 'delivered' : 'failed' });
        return response;
      } catch (error) {
        this.record({ ...event, status: 'failed' });
        throw error;
      }
    };
  }
}
