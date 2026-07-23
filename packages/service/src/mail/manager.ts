/**
 * MailManager — the sync engine for mail-enabled projects. Owns linking a
 * mailbox (storing its credential + recording the account on the project),
 * running a sync pass (incremental fetch → write immutable message markdown),
 * and reporting status. The background scheduler (phase 3) drives `syncProject`
 * on idle; the HTTP route drives it on demand.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectDetail, ProjectMail, ProjectMailAccount } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { syncWithAdapter } from '../connectors/manager.js';
import { writeFileAtomic } from '../fs/atomic.js';
import { resolveInside } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { parseFrontmatter, withFrontmatter } from '../index-store/frontmatter.js';
import type { SecretStore } from '../secrets/types.js';
import { MailConnectorAdapter } from './adapter.js';
import {
  type OAuthCredential,
  buildAuthUrl,
  createPkce,
  defaultFoldersFor,
  exchangeCode,
  microsoftTenant,
  randomState,
  resolveOAuthClient,
} from './oauth.js';
import {
  type DraftEmailInput,
  disallowedRecipients,
  draftFromFrontmatter,
  draftFrontmatter,
  newDraftId,
} from './outbox.js';
import { createMailProvider, mailSecretKey } from './registry.js';
import type { ImapCredential } from './types.js';

type OAuthProvider = OAuthCredential['provider'];

interface PendingOAuth {
  projectId: string;
  provider: OAuthProvider;
  address: string;
  clientId: string;
  clientSecret?: string;
  tenant?: string;
  redirectUri: string;
  verifier: string;
  syncFolders?: string[];
  createdAt: number;
  completion?: { account: ProjectMailAccount; credentialBlob: string };
}

export interface StartOAuthInput {
  provider: OAuthProvider;
  /** The mailbox address being linked (used as login hint + account id). */
  address: string;
  /** Redirect URI the shell will capture the code on (loopback or gezel://). */
  redirectUri: string;
  tenant?: string;
  syncFolders?: string[];
}

export class RecipientNotAllowedError extends Error {
  constructor(readonly recipients: string[]) {
    super(
      `recipient(s) not on this project's allowlist: ${recipients.join(', ')}. Add them to the project's allowedRecipients/allowedDomains to send.`,
    );
    this.name = 'RecipientNotAllowedError';
  }
}

export class DraftNotFoundError extends Error {
  constructor(draftId: string) {
    super(`no draft found with id ${draftId}`);
    this.name = 'DraftNotFoundError';
  }
}

export interface SendResult {
  status: 'sent' | 'queued-night-shift';
  messageId?: string;
  relPath: string;
}

const log = createLogger('mail');

export interface MailManagerOptions {
  store: Store;
  secrets: SecretStore;
  /** Optional: refresh the content index right after a sync so mail is searchable promptly. */
  contentIndex?: ContentIndex;
  /**
   * Whether night shift is active. When true, `sendDraft` refuses to transmit
   * and stages the message in `_outbox/` for explicit daytime approval — the
   * agent can draft overnight but never send unattended.
   */
  isNightShiftActive?: () => boolean;
}

export interface LinkMailboxInput {
  provider: ProjectMailAccount['provider'];
  address: string;
  displayName?: string;
  syncFolders?: string[];
  /** IMAP connection blob (provider === 'imap'). */
  imap?: ImapCredential;
}

export interface AccountSyncResult {
  accountId: string;
  written: number;
  quarantined: number;
  skipped: number;
  errors: number;
  error?: string;
}

export interface MailStatus {
  configured: boolean;
  accounts: {
    id: string;
    provider: string;
    address: string;
    syncFolders: string[];
    lastSyncedAt?: string;
    lastError?: string;
  }[];
}

export class MailManager {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** In-flight OAuth link sessions keyed by `state` (10-min TTL). */
  private readonly pendingOAuth = new Map<string, PendingOAuth>();

  constructor(private readonly opts: MailManagerOptions) {}

  /** Serialize state-mutating work per project (mirrors GitHubManager). */
  private withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(projectId, tail);
    void tail.then(() => {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    });
    return next;
  }

  /** Link (or re-link) an IMAP mailbox: persist its credential + record it. */
  async linkMailbox(project: ProjectDetail, input: LinkMailboxInput): Promise<ProjectMailAccount> {
    if (input.provider !== 'imap') {
      throw new Error(`use the OAuth flow (startOAuth/completeOAuth) for '${input.provider}'`);
    }
    if (!input.imap) throw new Error('imap connection details are required');

    const account: ProjectMailAccount = {
      id: `${input.provider}:${input.address}`,
      provider: input.provider,
      address: input.address,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      syncFolders: input.syncFolders?.length ? input.syncFolders : ['INBOX'],
    };
    return this.recordAccount(project, account, JSON.stringify(input.imap));
  }

  /**
   * Begin an OAuth link. Returns the URL the shell opens in the browser plus a
   * `state` to round-trip. PKCE verifier + provider config are held in memory
   * keyed by `state` until {@link completeOAuth}.
   */
  async startOAuth(
    project: ProjectDetail,
    input: StartOAuthInput,
  ): Promise<{ authUrl: string; state: string }> {
    const { clientId, clientSecret } = resolveOAuthClient(input.provider);
    const tenant = input.tenant ?? microsoftTenant(input.provider);
    const { verifier, challenge } = createPkce();
    const state = randomState();
    this.gcPendingOAuth();
    this.pendingOAuth.set(state, {
      projectId: project.id,
      provider: input.provider,
      address: input.address,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      tenant,
      redirectUri: input.redirectUri,
      verifier,
      ...(input.syncFolders ? { syncFolders: input.syncFolders } : {}),
      createdAt: Date.now(),
    });
    const authUrl = buildAuthUrl({
      provider: input.provider,
      clientId,
      redirectUri: input.redirectUri,
      state,
      challenge,
      tenant,
      loginHint: input.address,
    });
    return { authUrl, state };
  }

  /** Finish an OAuth link: exchange the code, store tokens, record the account. */
  async completeOAuth(
    project: ProjectDetail,
    args: { state: string; code: string },
  ): Promise<ProjectMailAccount> {
    this.gcPendingOAuth();
    const pending = this.pendingOAuth.get(args.state);
    if (!pending) throw new Error('oauth state not found or expired; restart the link flow');
    if (pending.projectId !== project.id) {
      throw new Error('oauth state belongs to a different project; restart the link flow');
    }

    if (!pending.completion) {
      const tokens = await exchangeCode({
        provider: pending.provider,
        clientId: pending.clientId,
        ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        code: args.code,
        codeVerifier: pending.verifier,
        redirectUri: pending.redirectUri,
        ...(pending.tenant ? { tenant: pending.tenant } : {}),
      });
      if (!tokens.refreshToken) {
        throw new Error(
          'OAuth succeeded but no refresh token was returned — ensure offline access / consent prompt is requested.',
        );
      }

      const cred: OAuthCredential = {
        provider: pending.provider,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        clientId: pending.clientId,
        ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        ...(pending.tenant ? { tenant: pending.tenant } : {}),
      };
      const account: ProjectMailAccount = {
        id: `${pending.provider}:${pending.address}`,
        provider: pending.provider,
        address: pending.address,
        syncFolders: pending.syncFolders?.length
          ? pending.syncFolders
          : defaultFoldersFor(pending.provider),
      };
      pending.completion = { account, credentialBlob: JSON.stringify(cred) };
    }

    const account = await this.recordAccount(
      project,
      pending.completion.account,
      pending.completion.credentialBlob,
    );
    this.pendingOAuth.delete(args.state);
    return account;
  }

  /** Persist a credential blob + record/replace the account on the project. */
  private recordAccount(
    project: ProjectDetail,
    account: ProjectMailAccount,
    credentialBlob: string,
  ): Promise<ProjectMailAccount> {
    return this.withLock(project.id, async () => {
      await this.opts.secrets.set(mailSecretKey(account), credentialBlob);
      const existing = project.mail?.accounts ?? [];
      const accounts = [...existing.filter((a) => a.id !== account.id), account];
      const mail: ProjectMail = { ...(project.mail ?? {}), accounts };
      await this.opts.store.updateProject(project.id, { mail });
      return account;
    });
  }

  private gcPendingOAuth(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.pendingOAuth) {
      if (v.createdAt < cutoff) this.pendingOAuth.delete(k);
    }
  }

  /** Sync every account on a project. Returns one result per account. */
  async syncProject(project: ProjectDetail): Promise<AccountSyncResult[]> {
    if (!project.mail?.accounts?.length) return [];
    return this.withLock(project.id, async () => {
      const results: AccountSyncResult[] = [];
      // Re-read the latest project so cursor writes accumulate across accounts.
      let current = (await this.opts.store.getProject(project.id)) ?? project;
      for (const account of current.mail?.accounts ?? []) {
        const r = await this.syncAccount(current, account);
        results.push(r);
        current = (await this.opts.store.getProject(project.id)) ?? current;
      }
      if (this.opts.contentIndex && results.some((r) => r.written + r.quarantined > 0)) {
        await this.opts.contentIndex.refresh(project.id).catch(() => {});
      }
      return results;
    });
  }

  private async syncAccount(
    project: ProjectDetail,
    account: ProjectMailAccount,
  ): Promise<AccountSyncResult> {
    const mailDir = project.mail?.mailDir ?? 'mail';
    const backfillLimit = project.mail?.backfillLimit ?? 500;
    try {
      const workspaceDir = await this.opts.store.projectWorkspaceDir(project.id);
      const provider = await createMailProvider(account, this.opts.secrets);
      const adapter = new MailConnectorAdapter(
        provider,
        account.syncFolders ?? ['INBOX'],
        account.id,
      );
      const r = await syncWithAdapter(adapter, {
        workspaceDir,
        corpusDir: mailDir,
        backfillLimit,
        cursor: account.cursor,
      });
      if (r.error) {
        log.warn(`sync failed (${account.id}): ${r.error}`);
        await this.persistAccount(project.id, account.id, {
          cursor: r.cursor,
          lastError: r.error,
        }).catch(() => {});
      } else {
        await this.persistAccount(project.id, account.id, {
          cursor: r.cursor,
          lastSyncedAt: new Date().toISOString(),
        });
      }
      return {
        accountId: account.id,
        written: r.written,
        quarantined: r.quarantined,
        skipped: r.skipped,
        errors: r.errors,
        ...(r.error ? { error: r.error } : {}),
      };
    } catch (err) {
      // createMailProvider / projectWorkspaceDir threw before the pass ran
      // (e.g. a missing credential). Keep the prior cursor and surface it.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`sync failed (${account.id}): ${message}`);
      await this.persistAccount(project.id, account.id, {
        cursor: account.cursor,
        lastError: message,
      }).catch(() => {});
      return {
        accountId: account.id,
        written: 0,
        quarantined: 0,
        skipped: 0,
        errors: 1,
        error: message,
      };
    }
  }

  /** Patch a single account's cursor/sync-state on the project. */
  private async persistAccount(
    projectId: string,
    accountId: string,
    patch: Partial<Pick<ProjectMailAccount, 'cursor' | 'lastSyncedAt' | 'lastError'>>,
  ): Promise<void> {
    const project = await this.opts.store.getProject(projectId);
    if (!project?.mail) return;
    const accounts = project.mail.accounts.map((a) =>
      a.id === accountId
        ? {
            ...a,
            ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
            ...(patch.lastSyncedAt
              ? { lastSyncedAt: patch.lastSyncedAt, lastError: undefined }
              : {}),
            ...(patch.lastError ? { lastError: patch.lastError } : {}),
          }
        : a,
    );
    await this.opts.store.updateProject(projectId, { mail: { ...project.mail, accounts } });
  }

  async status(project: ProjectDetail): Promise<MailStatus> {
    return {
      configured: !!project.mail?.accounts?.length,
      accounts: (project.mail?.accounts ?? []).map((a) => ({
        id: a.id,
        provider: a.provider,
        address: a.address,
        syncFolders: a.syncFolders ?? ['INBOX'],
        ...(a.lastSyncedAt ? { lastSyncedAt: a.lastSyncedAt } : {}),
        ...(a.lastError ? { lastError: a.lastError } : {}),
      })),
    };
  }

  // ── outbound (draft → queue → send) ───────────────────────────────────────

  /** Write a draft to `<mailDir>/_drafts/`. No network; always permitted. */
  async draftEmail(
    project: ProjectDetail,
    input: DraftEmailInput,
  ): Promise<{ draftId: string; relPath: string }> {
    const draftId = newDraftId();
    const { abs, rel } = await this.draftPaths(project, '_drafts', `${draftId}.md`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFileAtomic(
      abs,
      withFrontmatter(draftFrontmatter(input, 'draft', { draft_id: draftId }), input.body),
    );
    return { draftId, relPath: rel };
  }

  /** Move a draft to `<mailDir>/_outbox/` (staged for send). No network. */
  async queueEmail(project: ProjectDetail, draftId: string): Promise<{ relPath: string }> {
    return this.withLock(project.id, async () => {
      const found = await this.findDraft(project, draftId);
      if (!found) throw new DraftNotFoundError(draftId);
      const { abs, rel } = await this.draftPaths(
        project,
        '_outbox',
        `${this.safeDraftId(draftId)}.md`,
      );
      await mkdir(dirname(abs), { recursive: true });
      await writeFileAtomic(abs, withFrontmatter({ ...found.data, status: 'queued' }, found.body));
      if (found.abs !== abs) await rm(found.abs, { force: true });
      return { relPath: rel };
    });
  }

  /**
   * Transmit a draft. Authoritative gate: every recipient must clear the
   * project's allowlist (deny-by-default), and during night shift we refuse to
   * send — the message is staged in `_outbox/` for explicit daytime approval.
   * Either way nothing leaves the machine to an un-allowlisted address.
   */
  async sendDraft(project: ProjectDetail, draftId: string): Promise<SendResult> {
    return this.withLock(project.id, async () => {
      const found = await this.findDraft(project, draftId);
      if (!found) throw new DraftNotFoundError(draftId);
      const input = draftFromFrontmatter(found.data, found.body);

      const disallowed = disallowedRecipients(input, project.mail);
      if (disallowed.length > 0) throw new RecipientNotAllowedError(disallowed);

      if (this.opts.isNightShiftActive?.()) {
        const { abs, rel } = await this.draftPaths(
          project,
          '_outbox',
          `${this.safeDraftId(draftId)}.md`,
        );
        await mkdir(dirname(abs), { recursive: true });
        await writeFileAtomic(
          abs,
          withFrontmatter({ ...found.data, status: 'queued' }, found.body),
        );
        if (found.abs !== abs) await rm(found.abs, { force: true });
        return { status: 'queued-night-shift', relPath: rel };
      }

      const account = this.resolveSendAccount(project, input.accountId);
      const provider = await createMailProvider(account, this.opts.secrets);
      try {
        await provider.ensureAuth();
        const fromAddr = account.displayName
          ? `${account.displayName} <${account.address}>`
          : account.address;
        const sent = await provider.send(fromAddr, {
          to: input.to,
          ...(input.cc?.length ? { cc: input.cc } : {}),
          ...(input.bcc?.length ? { bcc: input.bcc } : {}),
          subject: input.subject,
          bodyMarkdown: input.body,
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        });
        const { abs, rel } = await this.draftPaths(
          project,
          '_sent',
          `${this.safeDraftId(draftId)}.md`,
        );
        await mkdir(dirname(abs), { recursive: true });
        await writeFileAtomic(
          abs,
          withFrontmatter(
            {
              ...found.data,
              status: 'sent',
              ...(sent.messageId ? { message_id: sent.messageId } : {}),
              sent_at: new Date().toISOString(),
            },
            found.body,
          ),
        );
        if (found.abs !== abs) await rm(found.abs, { force: true });
        return {
          status: 'sent',
          ...(sent.messageId ? { messageId: sent.messageId } : {}),
          relPath: rel,
        };
      } finally {
        await provider.close().catch(() => {});
      }
    });
  }

  /** UUID-shaped draft ids only — defends the filename against path tricks. */
  private safeDraftId(draftId: string): string {
    const safe = draftId.replace(/[^a-zA-Z0-9-]/g, '');
    if (!safe) throw new DraftNotFoundError(draftId);
    return safe;
  }

  private async draftPaths(
    project: ProjectDetail,
    sub: '_drafts' | '_outbox' | '_sent',
    name: string,
  ): Promise<{ abs: string; rel: string }> {
    const workspaceDir = await this.opts.store.projectWorkspaceDir(project.id);
    const mailDir = project.mail?.mailDir ?? 'mail';
    const rel = `${mailDir}/${sub}/${name}`;
    const abs = await resolveInside(workspaceDir, rel);
    return { abs, rel };
  }

  /** Find a draft by id in `_outbox/` (preferred) then `_drafts/`. */
  private async findDraft(
    project: ProjectDetail,
    draftId: string,
  ): Promise<{ abs: string; data: Record<string, string>; body: string } | null> {
    const safe = this.safeDraftId(draftId);
    for (const sub of ['_outbox', '_drafts'] as const) {
      const { abs } = await this.draftPaths(project, sub, `${safe}.md`);
      const content = await readFile(abs, 'utf8').catch(() => null);
      if (content != null) {
        const { data, body } = parseFrontmatter(content);
        return { abs, data, body };
      }
    }
    return null;
  }

  private resolveSendAccount(project: ProjectDetail, accountId?: string): ProjectMailAccount {
    const accounts = project.mail?.accounts ?? [];
    if (accountId) {
      const match = accounts.find((a) => a.id === accountId);
      if (match) return match;
    }
    if (accounts[0]) return accounts[0];
    throw new Error('project has no linked mailbox to send from');
  }
}
