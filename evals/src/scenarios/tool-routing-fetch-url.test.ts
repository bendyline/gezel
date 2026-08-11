import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import type { MockServicesRuntime } from '../mock/mock-server.ts';
import type { EvalContext } from '../types.ts';
import { getScenario } from './index.ts';
import {
  FETCH_URL_PROBE_BODY,
  FETCH_URL_PROBE_ID,
  FETCH_URL_RECEIPT_PATH,
  checkFetchUrlReceipt,
  toolRoutingFetchUrlScenario,
} from './tool-routing-fetch-url.ts';

const BASE_URL = 'https://127.0.0.1:43123';
const TARGET_URL = `${BASE_URL}/ingest/fetch-url`;
const VALID_RECEIPT = [
  '# Fetch URL receipt',
  `- URL: ${TARGET_URL}`,
  '- Method: POST',
  '- HTTP status: 200',
  '- Response: {"ok":true}',
  `- Probe: ${FETCH_URL_PROBE_ID}`,
].join('\n');

function context(opts: {
  requestSeen: boolean;
  historySeen: boolean;
  receipt?: string;
  contentType?: string;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  priorRequestBody?: string;
}): EvalContext {
  const requests = opts.requestSeen
    ? [
        ...(opts.priorRequestBody !== undefined
          ? [
              {
                at: new Date(0).toISOString(),
                method: 'POST',
                path: '/ingest/fetch-url',
                matchedRoute: 'POST /ingest/fetch-url',
                status: 200,
                authorized: true,
                contentType: 'application/json',
                requestBody: opts.priorRequestBody,
              },
            ]
          : []),
        {
          at: new Date(1).toISOString(),
          method: 'POST',
          path: '/ingest/fetch-url',
          matchedRoute: 'POST /ingest/fetch-url',
          status: 200,
          authorized: true,
          contentType: opts.contentType ?? 'application/json',
          requestBody: opts.requestBody ?? FETCH_URL_PROBE_BODY,
          ...(opts.requestBodyTruncated ? { requestBodyTruncated: true } : {}),
        },
      ]
    : [];
  const service = {
    id: 'fetch-receiver',
    kind: 'webhook' as const,
    baseUrl: BASE_URL,
    credentialName: null,
    token: null,
    requests,
  };
  const mocks = {
    services: new Map([[service.id, service]]),
  } as unknown as MockServicesRuntime;
  const client = {
    listProjects: vi.fn(async () => ({
      projects: [{ id: 'fetch-probe', name: 'Fetch URL Tool Probe' }],
    })),
    fetchProjectWorkspaceBlob: vi.fn(async (_projectId: string, path: string) => {
      if (path !== FETCH_URL_RECEIPT_PATH) throw new Error('not found');
      return new Blob([opts.receipt ?? VALID_RECEIPT]);
    }),
    listHistory: vi.fn(async () => ({
      entries: opts.historySeen
        ? [
            {
              entryType: 'event',
              kind: 'tool.called',
              summary: 'Tool fetch_url ran (12ms)',
              details: {
                name: 'fetch_url',
                success: true,
                researchTarget: TARGET_URL,
              },
            },
          ]
        : [],
    })),
  } as unknown as GezelClient;

  return {
    client,
    meesterId: 'meester',
    mocks,
    log: vi.fn(),
    logChanged: vi.fn(),
    recordSniff: vi.fn(),
  };
}

describe('tool-routing-fetch-url', () => {
  it('is registered as a first-class runnable scenario', () => {
    expect(getScenario('tool-routing-fetch-url')).toBe(toolRoutingFetchUrlScenario);
    expect(toolRoutingFetchUrlScenario.allowFetchUrlMockServiceIds).toEqual(['fetch-receiver']);
  });

  it('requires all receipt fields', () => {
    expect(checkFetchUrlReceipt(VALID_RECEIPT)).toMatchObject({
      ok: true,
      score: 4,
      scoreMax: 4,
      signals: ['post-method', 'http-200', 'ok-response', 'probe-id'],
    });
    expect(checkFetchUrlReceipt('POST returned 200')).toMatchObject({
      ok: false,
      score: 2,
      failReason: 'receipt does not record the {"ok":true} response',
    });
  });

  it('does not pass from a polished receipt alone', async () => {
    const result = await toolRoutingFetchUrlScenario.successCheck(
      context({ requestSeen: false, historySeen: false }),
    );
    expect(result).toEqual({ done: false });
  });

  it('does not pass without successful fetch_url History provenance', async () => {
    const result = await toolRoutingFetchUrlScenario.successCheck(
      context({ requestSeen: true, historySeen: false }),
    );
    expect(result).toEqual({ done: false });
  });

  it('does not pass an empty POST body even when the route and History match', async () => {
    const result = await toolRoutingFetchUrlScenario.successCheck(
      context({ requestSeen: true, historySeen: true, requestBody: '' }),
    );
    expect(result).toEqual({ done: false });
  });

  it('does not pass a non-empty but incorrect probe body', async () => {
    const result = await toolRoutingFetchUrlScenario.successCheck(
      context({ requestSeen: true, historySeen: true, requestBody: '{"probe":"wrong"}' }),
    );
    expect(result).toEqual({ done: false });
  });

  it('requires the exact application/json content type', async () => {
    const result = await toolRoutingFetchUrlScenario.successCheck(
      context({
        requestSeen: true,
        historySeen: true,
        contentType: 'application/json; charset=utf-8',
      }),
    );
    expect(result).toEqual({ done: false });
  });

  it('does not accept a truncated body even when its retained prefix matches', async () => {
    const result = await toolRoutingFetchUrlScenario.successCheck(
      context({
        requestSeen: true,
        historySeen: true,
        requestBody: FETCH_URL_PROBE_BODY,
        requestBodyTruncated: true,
      }),
    );
    expect(result).toEqual({ done: false });
  });

  it('passes only with receipt, real request evidence, and exact-target History', async () => {
    const result = await toolRoutingFetchUrlScenario.successCheck(
      context({ requestSeen: true, historySeen: true }),
    );
    expect(result).toMatchObject({
      done: true,
      success: true,
    });
  });

  it('recovers when an invalid POST is followed by a correct retry', async () => {
    const result = await toolRoutingFetchUrlScenario.successCheck(
      context({
        requestSeen: true,
        historySeen: true,
        priorRequestBody: '{"probe":"wrong"}',
      }),
    );
    expect(result).toMatchObject({ done: true, success: true });
  });
});
