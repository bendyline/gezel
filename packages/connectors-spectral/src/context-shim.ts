import type { ActionContext } from '@prismatic-io/spectral';

/**
 * A concrete, inert `ActionContext` for running a Prismatic component action
 * off-platform. Components mostly read `context.debug.enabled` + `context.logger`;
 * everything else is a harmless empty/inert value. Stable because the SDK is
 * pinned — a bump is a deliberate, tested event.
 */
export function makeContextShim(): ActionContext {
  const logger = {
    metric: () => {},
    trace: () => {},
    debug: () => {},
    info: () => {},
    log: () => {},
    warn: () => {},
    error: () => {},
  };
  const shim = {
    debug: { enabled: false, results: [] as unknown[] },
    logger,
    instanceState: {},
    crossFlowState: {},
    executionState: {},
    integrationState: {},
    stepId: 'gezel',
    executionId: 'gezel',
    customer: {},
    instance: {},
    user: {},
    flow: {},
    integration: {},
    startedAt: 0,
    invokeUrl: '',
    webhookUrls: {},
    webhookApiKeys: {},
  };
  return shim as unknown as ActionContext;
}
