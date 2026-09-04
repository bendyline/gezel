import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * HTTP contract for prompt drafts, including the two things the UI cannot
 * work around if they are wrong: a draft's uploads go through the ordinary
 * artifact routes (so the editor can treat it as a document folder), and a
 * gezel reaching for the same paths is refused.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-prompt-drafts-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function api(method: string, path: string, body?: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function raw(method: string, path: string, bytes?: Buffer) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}),
    },
    body: bytes,
  });
}

const DRAFTS = '/api/projects/default/prompt-drafts';

describe('the draft lifecycle', () => {
  it('carries a draft from first keystroke to re-filing and removal', async () => {
    const created = await api('POST', DRAFTS, {
      gezelId: 'tomas',
      sessionId: null,
      content: '# The PRD\n\nfirst pass',
    });
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { id: string; title: string; sessionId: null };
    expect(draft.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect(draft.title).toBe('The PRD');
    expect(draft.sessionId).toBeNull();

    // A new-thread draft is a distinct question from "any thread".
    const fresh = await (await api('GET', `${DRAFTS}?sessionId=new`)).json();
    expect((fresh as { drafts: Array<{ id: string }> }).drafts.map((d) => d.id)).toContain(
      draft.id,
    );

    const saved = await api('PUT', `${DRAFTS}/${draft.id}/content`, {
      content: '# The PRD\n\nsecond pass, much better',
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ deleted: false });

    const refiled = await api('PATCH', `${DRAFTS}/${draft.id}`, { sessionId: 's-123' });
    expect(refiled.status).toBe(200);
    expect(await refiled.json()).toMatchObject({ sessionId: 's-123' });

    const read = await (await api('GET', `${DRAFTS}/${draft.id}`)).json();
    expect((read as { content: string }).content).toContain('second pass');

    expect((await api('DELETE', `${DRAFTS}/${draft.id}`)).status).toBe(200);
    expect((await api('GET', `${DRAFTS}/${draft.id}`)).status).toBe(404);
  });

  it('reports a draft emptied to nothing as deleted, so the composer forgets it', async () => {
    const draft = (await (
      await api('POST', DRAFTS, { gezelId: 'tomas', content: 'typed then cleared' })
    ).json()) as { id: string };
    const saved = await api('PUT', `${DRAFTS}/${draft.id}/content`, { content: '  ' });
    expect(await saved.json()).toEqual({ draft: null, deleted: true });
    expect((await api('GET', `${DRAFTS}/${draft.id}`)).status).toBe(404);
  });

  it('copies a sent draft on Use again without disturbing the original', async () => {
    const draft = (await (
      await api('POST', DRAFTS, { gezelId: 'tomas', content: 'the standing ask' })
    ).json()) as { id: string };
    const copied = await api('POST', `${DRAFTS}/${draft.id}/duplicate`, {});
    expect(copied.status).toBe(201);
    const copy = (await copied.json()) as { id: string; content: string };
    expect(copy.id).not.toBe(draft.id);
    expect(copy.content).toBe('the standing ask');
    expect((await api('GET', `${DRAFTS}/${draft.id}`)).status).toBe(200);
  });

  it('rejects a malformed id before it can touch the disk', async () => {
    expect((await api('GET', `${DRAFTS}/..%2F..%2Fetc`)).status).toBe(400);
    expect((await api('DELETE', `${DRAFTS}/not-an-id`)).status).toBe(400);
  });

  it('deleting a draft that is already gone is a success, not an error', async () => {
    const res = await api('DELETE', `${DRAFTS}/2026-09-03-9999`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: false });
  });

  it('404s on an unknown project', async () => {
    const res = await api('POST', '/api/projects/nope/prompt-drafts', { gezelId: 'tomas' });
    expect(res.status).toBe(404);
  });
});

describe('a draft\u2019s uploads', () => {
  it('travel the ordinary artifact routes, and are refused to a gezel', async () => {
    const draft = (await (
      await api('POST', DRAFTS, { gezelId: 'tomas', content: 'with a picture' })
    ).json()) as { id: string };
    const filePath = `prompts/${draft.id}/message_files/a.png`;

    // The composer's own upload: no gezel, no session, allowed.
    const put = await raw(
      'PUT',
      `/api/projects/default/artifacts/raw?path=${encodeURIComponent(filePath)}`,
      Buffer.from('pretend png'),
    );
    expect(put.status).toBe(200);

    const back = await raw(
      'GET',
      `/api/projects/default/artifacts/read?raw=1&path=${encodeURIComponent(filePath)}`,
    );
    expect(back.status).toBe(200);
    expect(await back.text()).toBe('pretend png');

    // The same write attributed to a gezel is refused, in words a model can act on.
    const denied = await raw(
      'PUT',
      `/api/projects/default/artifacts/raw?path=${encodeURIComponent(filePath)}&gezelId=tomas`,
      Buffer.from('overwritten'),
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()) as { code: string }).toMatchObject({
      code: 'prompt-drafts-readonly',
    });

    // Still the user's bytes.
    const unchanged = await raw(
      'GET',
      `/api/projects/default/artifacts/read?raw=1&path=${encodeURIComponent(filePath)}`,
    );
    expect(await unchanged.text()).toBe('pretend png');
  });

  it('refuses a gezel editing or deleting the prompt itself', async () => {
    const draft = (await (
      await api('POST', DRAFTS, { gezelId: 'tomas', content: 'mine' })
    ).json()) as { id: string };
    const messagePath = `prompts/${draft.id}/message.md`;

    const write = await api('PUT', '/api/projects/default/artifacts/write', {
      path: messagePath,
      content: 'rewritten by a gezel',
      gezelId: 'tomas',
    });
    expect(write.status).toBe(403);

    const del = await api(
      'DELETE',
      `/api/projects/default/artifacts/delete?path=${encodeURIComponent(messagePath)}&gezelId=tomas`,
    );
    expect(del.status).toBe(403);

    // Reading is fine — a gezel may see what it was asked, just not change it.
    const read = await api(
      'GET',
      `/api/projects/default/artifacts/read?path=${encodeURIComponent(messagePath)}`,
    );
    expect(read.status).toBe(200);
    expect((await read.json()) as { content: string }).toMatchObject({ content: 'mine' });
  });
});

describe('sending a draft', () => {
  it('rewrites the draft\u2019s refs into the transcript and marks it sent', async () => {
    const gezelId = (
      (await (await api('POST', '/api/gezels', { name: 'Wendel' })).json()) as {
        id: string;
      }
    ).id;
    const sessionId = (
      (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
        id: string;
      }
    ).id;

    const draft = (await (
      await api('POST', DRAFTS, {
        gezelId,
        sessionId,
        content: 'look at this ![shot](message_files/a.png)',
      })
    ).json()) as { id: string };

    const sent = await api('POST', `/api/sessions/${sessionId}/send`, {
      message: 'look at this ![shot](message_files/a.png)',
      draftId: draft.id,
    });
    expect(sent.status).toBe(202);

    // The persisted user message carries the project-relative form, which is
    // the only shape the transcript's media resolution understands.
    const deadline = Date.now() + 10_000;
    let userMessage: { content: string; draftId?: string } | undefined;
    while (Date.now() < deadline && !userMessage) {
      const record = (await (await api('GET', `/api/sessions/${sessionId}`)).json()) as {
        messages: Array<{ role: string; content: string; draftId?: string }>;
      };
      userMessage = record.messages.find((m) => m.role === 'user');
      if (!userMessage) await new Promise((r) => setTimeout(r, 50));
    }
    expect(userMessage?.content).toBe(
      `look at this ![shot](artifacts/prompts/${draft.id}/message_files/a.png)`,
    );
    expect(userMessage?.draftId).toBe(draft.id);

    // The draft keeps the text as written, so it stays editable and reusable.
    const after = (await (await api('GET', `${DRAFTS}/${draft.id}`)).json()) as {
      status: string;
      sentSessionId: string;
      content: string;
    };
    expect(after.status).toBe('sent');
    expect(after.sentSessionId).toBe(sessionId);
    expect(after.content).toBe('look at this ![shot](message_files/a.png)');

    // And it drops out of the open-draft pickers.
    const open = (await (
      await api('GET', `${DRAFTS}?status=draft&sessionId=${sessionId}`)
    ).json()) as {
      drafts: Array<{ id: string }>;
    };
    expect(open.drafts.map((d) => d.id)).not.toContain(draft.id);
  }, 20_000);

  it('refuses a draft that does not belong to the session\u2019s project', async () => {
    const gezelId = (
      (await (await api('POST', '/api/gezels', { name: 'Bram' })).json()) as {
        id: string;
      }
    ).id;
    const sessionId = (
      (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
        id: string;
      }
    ).id;
    const res = await api('POST', `/api/sessions/${sessionId}/send`, {
      message: 'hello',
      draftId: '2026-09-03-9999',
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'prompt_draft_not_found',
    });
  }, 20_000);
});
