import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDetail } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import type { SecretStore } from '../secrets/types.js';
import { MailManager, RecipientNotAllowedError } from './manager.js';

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-mailmgr-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(ws, { recursive: true, force: true });
});

function makeManager(opts: { nightShift?: boolean } = {}): MailManager {
  const store = {
    projectWorkspaceDir: async () => ws,
  } as unknown as Store;
  const secrets = {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
  } as unknown as SecretStore;
  return new MailManager({
    store,
    secrets,
    ...(opts.nightShift !== undefined ? { isNightShiftActive: () => opts.nightShift! } : {}),
  });
}

function project(allowed: { recipients?: string[]; domains?: string[] } = {}): ProjectDetail {
  return {
    id: 'p1',
    name: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    packages: [],
    mail: {
      accounts: [{ id: 'imap:me@example.com', provider: 'imap', address: 'me@example.com' }],
      ...(allowed.recipients ? { allowedRecipients: allowed.recipients } : {}),
      ...(allowed.domains ? { allowedDomains: allowed.domains } : {}),
    },
  } as unknown as ProjectDetail;
}

describe('MailManager outbound gating', () => {
  it('writes a draft (no network) and threads draft → queue', async () => {
    const mgr = makeManager();
    const proj = project();
    const { draftId, relPath } = await mgr.draftEmail(proj, {
      to: ['friend@partner.com'],
      subject: 'Hi',
      body: 'hello',
    });
    expect(relPath).toMatch(/^mail\/_drafts\/.*\.md$/);
    const draftAbs = join(ws, relPath);
    expect((await stat(draftAbs)).isFile()).toBe(true);

    const queued = await mgr.queueEmail(proj, draftId);
    expect(queued.relPath).toMatch(/^mail\/_outbox\/.*\.md$/);
    // Draft moved out of _drafts.
    await expect(stat(draftAbs)).rejects.toBeTruthy();
  });

  it('refuses to send to a non-allowlisted recipient (deny-by-default)', async () => {
    const mgr = makeManager();
    const proj = project(); // no allowlist → nothing may be sent
    const { draftId } = await mgr.draftEmail(proj, {
      to: ['stranger@evil.example'],
      subject: 'x',
      body: 'y',
    });
    await expect(mgr.sendDraft(proj, draftId)).rejects.toBeInstanceOf(RecipientNotAllowedError);
  });

  it('refuses send when one of several recipients is off-allowlist', async () => {
    const mgr = makeManager();
    const proj = project({ domains: ['partner.com'] });
    const { draftId } = await mgr.draftEmail(proj, {
      to: ['ok@partner.com', 'bad@evil.example'],
      subject: 'x',
      body: 'y',
    });
    await expect(mgr.sendDraft(proj, draftId)).rejects.toBeInstanceOf(RecipientNotAllowedError);
  });

  it('stages (does not transmit) during night shift, even to allowlisted recipients', async () => {
    const mgr = makeManager({ nightShift: true });
    const proj = project({ recipients: ['friend@partner.com'] });
    const { draftId } = await mgr.draftEmail(proj, {
      to: ['friend@partner.com'],
      subject: 'x',
      body: 'y',
    });
    const result = await mgr.sendDraft(proj, draftId);
    expect(result.status).toBe('queued-night-shift');
    expect(result.relPath).toMatch(/^mail\/_outbox\/.*\.md$/);
    const staged = await readFile(join(ws, result.relPath), 'utf8');
    expect(staged).toContain('status: queued');
  });

  it('allows by domain allowlist (would proceed past the gate)', async () => {
    const mgr = makeManager({ nightShift: true }); // night shift staging avoids real SMTP
    const proj = project({ domains: ['partner.com'] });
    const { draftId } = await mgr.draftEmail(proj, {
      to: ['Friend <friend@partner.com>'],
      subject: 'x',
      body: 'y',
    });
    const result = await mgr.sendDraft(proj, draftId);
    // Passed the allowlist (didn't throw) and got staged by the night-shift gate.
    expect(result.status).toBe('queued-night-shift');
  });
});

describe('MailManager OAuth state binding', () => {
  it('refuses to complete a state from a different project', async () => {
    const previousClientId = process.env.GEZEL_GOOGLE_CLIENT_ID;
    process.env.GEZEL_GOOGLE_CLIENT_ID = 'test-client';
    try {
      const mgr = makeManager();
      const source = project();
      const other = { ...project(), id: 'p2', name: 'p2' };
      const { state } = await mgr.startOAuth(source, {
        provider: 'gmail',
        address: 'me@example.com',
        redirectUri: 'http://127.0.0.1/oauth/callback',
      });

      await expect(mgr.completeOAuth(other, { state, code: 'stolen-code' })).rejects.toThrow(
        /different project/,
      );
    } finally {
      if (previousClientId === undefined) delete process.env.GEZEL_GOOGLE_CLIENT_ID;
      else process.env.GEZEL_GOOGLE_CLIENT_ID = previousClientId;
    }
  });

  it('retains exchanged OAuth state when project persistence transiently fails', async () => {
    const previousClientId = process.env.GEZEL_GOOGLE_CLIENT_ID;
    process.env.GEZEL_GOOGLE_CLIENT_ID = 'test-client';
    let updateAttempts = 0;
    let exchanges = 0;
    const store = {
      projectWorkspaceDir: async () => ws,
      updateProject: async () => {
        updateAttempts += 1;
        if (updateAttempts === 1) throw new Error('temporary disk failure');
      },
    } as unknown as Store;
    const secrets = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    } as unknown as SecretStore;
    vi.stubGlobal('fetch', async () => {
      exchanges += 1;
      return new Response(
        JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    try {
      const mgr = new MailManager({ store, secrets });
      const source = project();
      const { state } = await mgr.startOAuth(source, {
        provider: 'gmail',
        address: 'me@example.com',
        redirectUri: 'http://127.0.0.1/oauth/callback',
      });

      await expect(mgr.completeOAuth(source, { state, code: 'valid-code' })).rejects.toThrow(
        /temporary disk failure/,
      );
      await expect(mgr.completeOAuth(source, { state, code: 'valid-code' })).resolves.toMatchObject(
        {
          provider: 'gmail',
          address: 'me@example.com',
        },
      );
      expect(exchanges).toBe(1);
      expect(updateAttempts).toBe(2);
    } finally {
      if (previousClientId === undefined) delete process.env.GEZEL_GOOGLE_CLIENT_ID;
      else process.env.GEZEL_GOOGLE_CLIENT_ID = previousClientId;
    }
  });
});
