import type { MockServicesRuntime } from './mock/mock-server.ts';

export const EVAL_HERMETIC_ENV = 'GEZEL_EVAL_HERMETIC';
export const EVAL_FETCH_URL_ORIGINS_ENV = 'GEZEL_EVAL_FETCH_URL_ALLOWED_ORIGINS';

/**
 * Translate explicitly named per-trial HTTP mocks into the two-key daemon
 * environment contract used by the fetch_url SSRF guard. Throws on every
 * ambiguous shape so a typo cannot silently widen or disable the probe.
 */
export function evalFetchUrlMockOriginEnv(
  runtime: Pick<MockServicesRuntime, 'services'> | null,
  mockIds: readonly string[],
): Record<string, string> {
  if (mockIds.length === 0) return {};
  if (!runtime) {
    throw new Error('scenario requested fetch_url mock origins but no mock runtime started');
  }

  const exactOrigins: string[] = [];
  for (const id of mockIds) {
    const service = runtime.services.get(id);
    if (!service) throw new Error(`fetch_url mock service ${JSON.stringify(id)} is not running`);
    if (service.kind !== 'http' && service.kind !== 'webhook') {
      throw new Error(
        `fetch_url mock service ${JSON.stringify(id)} has non-HTTP kind ${service.kind}`,
      );
    }

    let url: URL;
    try {
      url = new URL(service.baseUrl);
    } catch {
      throw new Error(`fetch_url mock service ${JSON.stringify(id)} has an invalid base URL`);
    }
    if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1') {
      throw new Error(
        `fetch_url mock service ${JSON.stringify(id)} is not an HTTPS loopback origin`,
      );
    }
    exactOrigins.push(url.origin);
  }

  return {
    [EVAL_HERMETIC_ENV]: '1',
    [EVAL_FETCH_URL_ORIGINS_ENV]: JSON.stringify([...new Set(exactOrigins)]),
  };
}
