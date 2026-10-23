import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import {
  registerConnectorTools,
  registerEmailTools,
  registerSocialTools,
} from './connector-action-tools.js';

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
type Route = (body: unknown) => { status?: number; body: unknown };

const BINDINGS = [
  { id: 'gh', type: 'github-issues' },
  { id: 'work mail', type: 'mail-gmail' },
  { id: 'home-mail', type: 'mail-imap' },
  { id: 'sky', type: 'bluesky-feed' },
];

function setup(
  register: typeof registerEmailTools,
  routes: Record<string, Route>,
  bindings: unknown[] = BINDINGS,
) {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: vi.fn((name: string, _description: string, _shape: unknown, handler: Handler) => {
      handlers.set(name, handler);
    }),
  };
  const requests: Array<{ method: string; path: string; auth: string; body: unknown }> = [];
  const prefix = 'https://gezel.test/api/projects/p1/connectors';
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).slice(prefix.length);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ method, path, auth: headers.Authorization ?? '', body });
    const key = `${method} ${path}`;
    const reply = routes[key]?.(body) ?? (key === 'GET ' ? { body: { bindings } } : undefined);
    if (!reply) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  register({
    server: server as unknown as McpServer,
    baseUrl: 'https://gezel.test',
    token: 'SESSION',
    projectId: 'p1',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    unwrapApiError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  async function call(name: string, args: Record<string, unknown>) {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} was not registered`);
    const result = await handler(args, {});
    const block = result.content[0];
    return {
      text: block?.type === 'text' ? block.text : '',
      isError: result.isError === true,
      structured: result.structuredContent,
    };
  }
  return { handlers, requests, call };
}

describe('registerEmailTools', () => {
  it('registers the mail write path', () => {
    expect([...setup(registerEmailTools, {}).handlers.keys()]).toEqual([
      'draft_email',
      'queue_email',
      'save_email_draft',
      'send_email',
    ]);
  });

  it('drafts on the first mail binding, never on another connector type', async () => {
    const { call, requests } = setup(registerEmailTools, {
      'POST /work%20mail/actions': () => ({ body: { draftId: 'd1', relPath: 'outbox/d1.md' } }),
    });

    const { text, isError, structured } = await call('draft_email', {
      to: ['ada@example.test'],
      subject: 'Hi',
      body: 'Hello',
    });

    expect(isError).toBe(false);
    expect(text).toBe(
      'Draft saved (id: d1) at outbox/d1.md. Review it, then call queue_email then send_email.',
    );
    expect(structured).toMatchObject({ status: 'drafted', draftId: 'd1' });
    expect(requests[1]).toEqual({
      method: 'POST',
      path: '/work%20mail/actions',
      auth: 'Bearer SESSION',
      body: { action: 'send', input: { to: ['ada@example.test'], subject: 'Hi', body: 'Hello' } },
    });
  });

  it('drafts on the named account and refuses one that is not a mail binding', async () => {
    const { call, requests } = setup(registerEmailTools, {
      'POST /home-mail/actions': () => ({ body: { draftId: 'd2' } }),
    });

    await call('draft_email', { to: [], subject: 's', body: 'b', accountId: 'home-mail' });
    expect(requests[1]?.body).toEqual({
      action: 'send',
      input: { to: [], subject: 's', body: 'b' },
    });

    const refused = await call('draft_email', { to: [], subject: 's', body: 'b', accountId: 'gh' });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('mail connector binding "gh" was not found');
  });

  it('says so when the project has no mail connector', async () => {
    const { call } = setup(registerEmailTools, {}, [{ id: 'gh', type: 'github-issues' }]);
    const result = await call('draft_email', { to: [], subject: 's', body: 'b' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('This project has no linked mail connector.');
  });

  it('saves a mailbox draft by drafting and committing in one call', async () => {
    const { call, requests } = setup(registerEmailTools, {
      'POST /work%20mail/actions': () => ({ body: { draftId: 'd3' } }),
      'POST /actions/d3/commit': () => ({ body: { result: { webLink: 'https://mail.test/d3' } } }),
    });

    const result = await call('save_email_draft', { to: ['a@b.test'], subject: 's', body: 'b' });

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      'Saved to the Drafts folder. Nothing was sent — the user can review and send it from their mail app. https://mail.test/d3',
    );
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET ',
      'POST /work%20mail/actions',
      'POST /actions/d3/commit',
    ]);
    expect(requests[1]?.body).toMatchObject({ action: 'save-draft' });
  });

  it('explains a mail connection that cannot save drafts or was linked without the scope', async () => {
    const noAction = setup(registerEmailTools, {
      'POST /work%20mail/actions': () => ({
        status: 400,
        body: { error: "connector type declares no action 'save-draft'" },
      }),
    });
    const unsupported = await noAction.call('save_email_draft', {
      to: [],
      subject: 's',
      body: 'b',
    });
    expect(unsupported.isError).toBe(true);
    expect(unsupported.text).toContain('does not support mailbox drafts yet');

    const noScope = setup(registerEmailTools, {
      'POST /work%20mail/actions': () => ({ body: { draftId: 'd4' } }),
      'POST /actions/d4/commit': () => ({ status: 502, body: { error: 'Graph 403 Forbidden' } }),
    });
    const relink = await noScope.call('save_email_draft', { to: [], subject: 's', body: 'b' });
    expect(relink.isError).toBe(true);
    expect(relink.text).toContain('re-link the account');
  });

  it('queues a draft without transmitting it', async () => {
    const { call } = setup(registerEmailTools, {
      'POST /actions/d1/queue': () => ({ body: { relPath: 'outbox/queued/d1.md' } }),
    });
    const result = await call('queue_email', { draftId: 'd1' });
    expect(result.text).toBe('Queued draft d1 (outbox/queued/d1.md).');
    expect(result.structured).toMatchObject({ status: 'queued', draftId: 'd1' });
  });

  it('reports a send, a night-shift hold, and an allowlist refusal', async () => {
    const { call } = setup(registerEmailTools, {
      'POST /actions/sent/commit': () => ({ body: { result: { messageId: '<m1@test>' } } }),
      'POST /actions/night/commit': () => ({
        body: { status: 'queued-night-shift', relPath: 'outbox/night.md' },
      }),
      'POST /actions/blocked/commit': () => ({
        status: 403,
        body: { error: 'recipient is not on the allowlist' },
      }),
    });

    expect((await call('send_email', { draftId: 'sent' })).text).toBe(
      'Sent. Message-ID: <m1@test>',
    );

    const night = await call('send_email', { draftId: 'night' });
    expect(night.text).toContain('Night shift is active — not sending unattended');
    expect(night.structured).toMatchObject({ status: 'queued-night-shift' });

    const blocked = await call('send_email', { draftId: 'blocked' });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("add the recipient to the connector's allowed recipients");
  });

  it('turns a failed binding listing into a tool error', async () => {
    const { call } = setup(registerEmailTools, {
      'GET ': () => ({ status: 500, body: { error: 'connectors are busy' } }),
    });
    const result = await call('draft_email', { to: [], subject: 's', body: 'b' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('draft_email failed: connectors are busy');
  });
});

describe('registerSocialTools', () => {
  it('drafts on the first social binding', async () => {
    const { call, requests, handlers } = setup(registerSocialTools, {
      'POST /sky/actions': () => ({ body: { draftId: 'p1' } }),
    });
    expect([...handlers.keys()]).toEqual(['draft_post', 'queue_post', 'publish_post']);

    const result = await call('draft_post', { text: 'Hello' });

    expect(result.text).toBe(
      'Draft saved (id: p1). Review it, then call queue_post then publish_post.',
    );
    expect(requests[1]).toMatchObject({
      path: '/sky/actions',
      body: { action: 'publish', input: { text: 'Hello' } },
    });
  });

  it('says so when the project has no social connector', async () => {
    const { call } = setup(registerSocialTools, {}, [{ id: 'm', type: 'mail-gmail' }]);
    const result = await call('draft_post', { text: 'Hello' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('This project has no linked social connector.');
  });

  it('reports a publish with its link, a night-shift hold, and disabled publishing', async () => {
    const { call } = setup(registerSocialTools, {
      'POST /actions/p1/queue': () => ({ body: {} }),
      'POST /actions/p1/commit': () => ({
        body: { result: { uri: 'at://x', permalink: 'https://bsky.test/p1' } },
      }),
      'POST /actions/p2/commit': () => ({ body: { status: 'queued-night-shift' } }),
      'POST /actions/p3/commit': () => ({
        status: 403,
        body: { error: 'Publishing is disabled on this connector' },
      }),
    });

    expect((await call('queue_post', { draftId: 'p1' })).text).toBe('Queued draft p1.');
    expect((await call('publish_post', { draftId: 'p1' })).text).toBe(
      'Published. https://bsky.test/p1',
    );
    expect((await call('publish_post', { draftId: 'p2' })).text).toContain(
      'Night shift is active — not publishing unattended',
    );
    const disabled = await call('publish_post', { draftId: 'p3' });
    expect(disabled.isError).toBe(true);
    expect(disabled.text).toContain("enable 'Allow publishing'");
  });
});

describe('registerConnectorTools', () => {
  it('drafts an action for the person to commit', async () => {
    const { call, requests } = setup(registerConnectorTools, {
      'POST /gh/actions': () => ({ body: { draftId: 'a1', relPath: 'actions/a1.json' } }),
    });

    const result = await call('draft_connector_action', {
      bindingId: 'gh',
      action: 'comment',
      input: { issue: 4, body: 'Thanks' },
    });

    expect(result.text).toBe(
      'Action drafted (id: a1) at actions/a1.json. The user reviews and commits it — you cannot commit it yourself.',
    );
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/gh/actions',
        auth: 'Bearer SESSION',
        body: { action: 'comment', input: { issue: 4, body: 'Thanks' } },
      },
    ]);
  });

  it('passes the daemon refusal through', async () => {
    const { call } = setup(registerConnectorTools, {
      'POST /gh/actions': () => ({ status: 400, body: { error: "unknown action 'merge'" } }),
    });
    const result = await call('draft_connector_action', { bindingId: 'gh', action: 'merge' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("unknown action 'merge'");
  });
});
