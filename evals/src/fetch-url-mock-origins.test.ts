import { describe, expect, it } from 'vitest';
import {
  EVAL_FETCH_URL_ORIGINS_ENV,
  EVAL_HERMETIC_ENV,
  evalFetchUrlMockOriginEnv,
} from './fetch-url-mock-origins.ts';
import type { StartedMockService } from './mock/mock-server.ts';

function service(
  id: string,
  kind: StartedMockService['kind'],
  baseUrl: string,
): StartedMockService {
  return {
    id,
    kind,
    baseUrl,
    credentialName: null,
    token: null,
    requests: [],
  };
}

describe('evalFetchUrlMockOriginEnv', () => {
  it('emits a two-key exact-origin grant only for named HTTP-capable mocks', () => {
    const runtime = {
      services: new Map([
        ['receiver', service('receiver', 'webhook', 'https://127.0.0.1:43123')],
        ['unselected', service('unselected', 'http', 'https://127.0.0.1:43124')],
      ]),
    };

    expect(evalFetchUrlMockOriginEnv(runtime, ['receiver', 'receiver'])).toEqual({
      [EVAL_HERMETIC_ENV]: '1',
      [EVAL_FETCH_URL_ORIGINS_ENV]: '["https://127.0.0.1:43123"]',
    });
  });

  it('grants nothing when the scenario did not opt in', () => {
    expect(evalFetchUrlMockOriginEnv(null, [])).toEqual({});
  });

  it('fails closed for missing or non-HTTP-capable mock ids', () => {
    expect(() => evalFetchUrlMockOriginEnv({ services: new Map() }, ['missing'])).toThrow(
      'is not running',
    );
    expect(() =>
      evalFetchUrlMockOriginEnv(
        {
          services: new Map([['browser', service('browser', 'mcp', 'https://127.0.0.1:43123')]]),
        },
        ['browser'],
      ),
    ).toThrow('non-HTTP kind mcp');
  });

  it('rejects public, plaintext, and wildcard-like origins', () => {
    for (const baseUrl of [
      'https://example.test:43123',
      'http://127.0.0.1:43123',
      'https://localhost:43123',
      'https://*.example.test',
    ]) {
      expect(() =>
        evalFetchUrlMockOriginEnv(
          { services: new Map([['receiver', service('receiver', 'webhook', baseUrl)]]) },
          ['receiver'],
        ),
      ).toThrow();
    }
  });
});
