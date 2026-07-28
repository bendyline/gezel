import { describe, expect, it, vi } from 'vitest';
import type { HostMessage, WebviewFetchRequest } from './bridge.js';
import type { ChatViewProvider } from './chat-view.js';
import type { Connection } from './daemon.js';
import type { Logger } from './log.js';
import { WebviewRpc } from './webview-rpc.js';

function request(url: string): WebviewFetchRequest {
  return {
    type: 'fetch-request',
    id: 'request-1',
    url,
    method: 'GET',
    headers: { authorization: 'Bearer attacker-controlled' },
    body: null,
  };
}

function harness(fetchImpl: typeof fetch) {
  const messages: HostMessage[] = [];
  const view = {
    post(message: HostMessage) {
      messages.push(message);
    },
  } as unknown as ChatViewProvider;
  const connection = {
    baseUrl: 'https://127.0.0.1:43935',
    token: 'HOST-ONLY-TOKEN',
    firstPartyToken: 'FIRST-PARTY-HOST-ONLY-TOKEN',
    fetch: fetchImpl,
  } as Connection;
  const logger = { warn: vi.fn() } as unknown as Logger;
  return {
    messages,
    rpc: new WebviewRpc(view, () => connection, logger),
    logger,
  };
}

describe('WebviewRpc credential boundary', () => {
  it('rejects cross-origin absolute URLs before attaching the daemon token', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const { messages, rpc } = harness(fetchMock);

    await rpc.handleRequest(request('https://attacker.example/collect'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'fetch-response-start', status: 502 }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'fetch-response-end',
        error: expect.stringMatching(/cross-origin/),
      }),
    );
  });

  it('proxies same-origin paths and replaces any webview-supplied authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    const { messages, rpc } = harness(fetchMock as unknown as typeof fetch);

    await rpc.handleRequest(request('/api/projects'));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://127.0.0.1:43935/api/projects',
      expect.objectContaining({
        headers: { authorization: 'Bearer HOST-ONLY-TOKEN' },
        redirect: 'manual',
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'fetch-response-end', error: null }),
    );
  });
});
