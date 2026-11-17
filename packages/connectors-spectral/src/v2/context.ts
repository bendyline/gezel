/**
 * The context a component's action or trigger runs in, off the Prismatic
 * platform. Components read `logger`, `debug`, the instance state that
 * carries a polling trigger's position, and the batch flag that tells a
 * polling trigger to fetch one page per perform; everything else is inert.
 */

import { scrub } from './failure.js';

const MAX_LOG_LINES = 50;
const MAX_LOG_CHARS = 500;

export interface RunContext {
  context: Record<string, unknown>;
  logs: string[];
  /** The polling state the trigger last set. */
  pollingState(): unknown;
}

export function makeRunContext(opts: {
  state?: unknown;
  batchSize?: number;
  secrets: readonly string[];
}): RunContext {
  const logs: string[] = [];
  const log =
    (level: string) =>
    (...args: unknown[]) => {
      if (logs.length >= MAX_LOG_LINES) return;
      const text = args
        .map((a) => (typeof a === 'string' ? a : safeJson(a)))
        .join(' ')
        .slice(0, MAX_LOG_CHARS);
      logs.push(scrub(`${level}: ${text}`, opts.secrets));
    };
  const noop = () => {};
  const instanceState: Record<string, unknown> = {};
  if (opts.state !== undefined && opts.state !== null) {
    instanceState.__prismaticInternal = { polling: opts.state };
  }
  const startedAt = new Date().toISOString();
  const context: Record<string, unknown> = {
    logger: {
      metric: noop,
      trace: noop,
      debug: noop,
      info: log('info'),
      log: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
    instanceState,
    crossFlowState: {},
    executionState: {},
    integrationState: {},
    configVars: {},
    components: {},
    stepId: 'gezel',
    executionId: 'gezel',
    webhookUrls: {},
    webhookApiKeys: {},
    invokeUrl: '',
    customer: { id: 'gezel', name: 'Gezel', externalId: 'gezel' },
    instance: { id: 'gezel', name: 'Gezel' },
    user: { id: 'gezel', email: '', name: 'Gezel', externalId: 'gezel' },
    integration: { id: 'gezel', name: 'Gezel', versionSequenceId: '0', externalVersion: '0' },
    flow: { id: 'gezel', name: 'Gezel', stableId: 'gezel' },
    startedAt,
    executionFrame: {
      invokedByExecutionJWT: '',
      invokedByExecutionStartedAt: startedAt,
      componentActionKey: '',
      executionId: 'gezel',
      executionStartedAt: startedAt,
      stepName: 'gezel',
      loopPath: '',
    },
    debug: {
      enabled: false,
      timeElapsed: { mark: noop, measure: noop },
      memoryUsage: noop,
      results: {
        timeElapsed: { marks: {}, measurements: {} },
        memoryUsage: [],
        allowedMemory: 1024,
      },
    },
    flowSchemas: {},
    batch:
      opts.batchSize !== undefined
        ? { enabled: true, batchSize: opts.batchSize }
        : { enabled: false },
    invokeFlow: async () => {
      throw new Error('a connector cannot invoke flows');
    },
  };
  return {
    context,
    logs,
    pollingState: () => {
      const internal = instanceState.__prismaticInternal as { polling?: unknown } | undefined;
      return internal?.polling ?? null;
    },
  };
}

/** The empty trigger payload a scheduled poll starts from. */
export function basePayload(paginationState?: unknown): Record<string, unknown> {
  return {
    headers: {},
    queryParameters: {},
    rawBody: { data: null },
    body: { data: null },
    pathFragment: '',
    webhookUrls: {},
    webhookApiKeys: {},
    invokeUrl: '',
    executionId: 'gezel',
    customer: { id: 'gezel', name: 'Gezel', externalId: 'gezel' },
    instance: { id: 'gezel', name: 'Gezel' },
    user: { id: 'gezel', email: '', name: 'Gezel', externalId: 'gezel' },
    integration: { id: 'gezel', name: 'Gezel', versionSequenceId: '0', externalVersion: '0' },
    flow: { id: 'gezel', name: 'Gezel', stableId: 'gezel' },
    startedAt: new Date().toISOString(),
    ...(paginationState !== undefined && paginationState !== null ? { paginationState } : {}),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
