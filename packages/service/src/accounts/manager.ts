import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ACCOUNT_PASSWORD_MAX_LENGTH,
  ACCOUNT_PASSWORD_MIN_LENGTH,
  type Account,
  type AccountPrincipal,
  type AccountSession,
  DEFAULT_ACCOUNT_ROLE,
  type HistoryEvent,
  accountCanManageAccounts,
  isKnownAccountRole,
} from '@bendyline/gezel';
import { accountSessionsFile, accountsFile } from '@bendyline/gezel/paths';
import {
  DEFAULT_SCRYPT_PARAMS,
  type ScryptParams,
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './passwords.js';
import {
  type StoredAccount,
  type StoredSession,
  readAccounts,
  readSessions,
  writeAccounts,
  writeSessions,
} from './store.js';
import { SignInThrottle } from './throttle.js';

const DAY_MS = 24 * 60 * 60_000;
/** A session ends after this long unused… */
const SLIDING_EXPIRY_MS = 30 * DAY_MS;
/** …and after this long whatever happens. */
const ABSOLUTE_EXPIRY_MS = 90 * DAY_MS;
/** How stale `lastSeenAt` may get on disk; in memory it is exact. */
const LAST_SEEN_WRITE_INTERVAL_MS = 10 * 60_000;
const SETUP_CODE_TTL_MS = 60 * 60_000;
const SESSION_TOKEN_PREFIX = 'gzs_';
const FAILURE_LOG_INTERVAL_MS = 5 * 60_000;

export type AccountErrorCode =
  | 'name_taken'
  | 'not_found'
  | 'last_admin'
  | 'wrong_password'
  | 'sign_in_failed'
  | 'throttled'
  | 'setup_closed'
  | 'setup_code_invalid'
  | 'invalid_password';

/** A refusal the HTTP layer turns into a 4xx with a plain message. */
export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export interface SignInResult {
  token: string;
  expiresAt: string;
  account: Account;
}

export interface ResolvedSession {
  sessionId: string;
  account: Account;
  principal: AccountPrincipal;
}

export interface SessionMeta {
  label?: string;
  address?: string;
}

interface HistorySink {
  log(event: Omit<HistoryEvent, 'id' | 'at'>): Promise<void>;
}

export interface AccountManagerOptions {
  home: string;
  history?: HistorySink;
  now?: () => number;
  scrypt?: ScryptParams;
  warn?: (message: string) => void;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();
const nameKey = (name: string) => name.trim().normalize('NFKC').toLowerCase();

function toPublic(stored: StoredAccount): Account {
  const { passwordHash: _hash, ...account } = stored;
  return Object.fromEntries(
    Object.entries(account).filter(([, value]) => value !== undefined),
  ) as Account;
}

/** Crockford base32, grouped: easy to read out of a log and type back in. */
function newSetupCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(20);
  let code = '';
  for (let i = 0; i < 20; i++) code += alphabet[bytes[i]! % 32];
  return code.match(/.{5}/g)!.join('-');
}

const normalizeSetupCode = (code: string) =>
  code
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');

/**
 * Accounts and their sessions (ADR 0029). Everything is held in memory and
 * written through to `accounts.json` / `account-sessions.json` on change,
 * so the per-request session check stays synchronous.
 */
export class AccountManager {
  private accounts = new Map<string, StoredAccount>();
  private sessionsByHash = new Map<string, StoredSession>();
  private readonly lastWritten = new Map<string, number>();
  private readonly throttle: SignInThrottle;
  private readonly now: () => number;
  private readonly scrypt: ScryptParams;
  private readonly accountsPath: string;
  private readonly sessionsPath: string;
  private setupCode: { normalized: string; display: string; expiresAt: number } | null = null;
  private readonly failureLoggedAt = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;

  private constructor(private readonly opts: AccountManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.scrypt = opts.scrypt ?? DEFAULT_SCRYPT_PARAMS;
    this.throttle = new SignInThrottle(this.now);
    this.accountsPath = accountsFile(opts.home);
    this.sessionsPath = accountSessionsFile(opts.home);
  }

  static async open(opts: AccountManagerOptions): Promise<AccountManager> {
    const manager = new AccountManager(opts);
    for (const account of await readAccounts(manager.accountsPath)) {
      manager.accounts.set(account.id, account);
    }
    const at = manager.now();
    for (const session of await readSessions(manager.sessionsPath)) {
      if (manager.accounts.has(session.accountId) && manager.sessionAlive(session, at)) {
        manager.sessionsByHash.set(session.tokenHash, session);
        manager.lastWritten.set(session.id, Date.parse(session.lastSeenAt));
      }
    }
    return manager;
  }

  // ── queries ────────────────────────────────────────────────────────────

  hasAccounts(): boolean {
    return this.accounts.size > 0;
  }

  list(): Account[] {
    return [...this.accounts.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toPublic);
  }

  get(id: string): Account | null {
    const stored = this.accounts.get(id);
    return stored ? toPublic(stored) : null;
  }

  /**
   * The per-request check: a session token in, the account behind it out.
   * Synchronous because token lookup is. Slides the session's expiry.
   */
  resolve(token: string): ResolvedSession | null {
    if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;
    const session = this.sessionsByHash.get(hashToken(token));
    if (!session) return null;
    const at = this.now();
    const account = this.accounts.get(session.accountId);
    if (
      !account ||
      account.disabledAt ||
      !isKnownAccountRole(account.role) ||
      !this.sessionAlive(session, at)
    ) {
      return null;
    }
    session.lastSeenAt = iso(at);
    if (at - (this.lastWritten.get(session.id) ?? 0) > LAST_SEEN_WRITE_INTERVAL_MS) {
      this.scheduleSessionFlush();
    }
    return {
      sessionId: session.id,
      account: toPublic(account),
      principal: { id: account.id, source: 'password', label: account.name },
    };
  }

  listSessions(accountId?: string, currentSessionId?: string): AccountSession[] {
    const at = this.now();
    return [...this.sessionsByHash.values()]
      .filter((s) => (accountId ? s.accountId === accountId : true) && this.sessionAlive(s, at))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((s) => ({
        id: s.id,
        accountId: s.accountId,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: iso(this.sessionExpiresAt(s)),
        ...(s.label ? { label: s.label } : {}),
        ...(s.address ? { address: s.address } : {}),
        ...(s.id === currentSessionId ? { current: true } : {}),
      }));
  }

  canManageAccounts(accountId: string): boolean {
    const account = this.accounts.get(accountId);
    return Boolean(account && !account.disabledAt && accountCanManageAccounts(account.role));
  }

  // ── setup ──────────────────────────────────────────────────────────────

  /**
   * Mint the single-use setup code, while no account exists. Returns the
   * code to print, or null once someone has an account. Re-minting replaces
   * the previous code.
   */
  mintSetupCode(): string | null {
    if (this.hasAccounts()) {
      this.setupCode = null;
      return null;
    }
    const display = newSetupCode();
    this.setupCode = {
      normalized: normalizeSetupCode(display),
      display,
      expiresAt: this.now() + SETUP_CODE_TTL_MS,
    };
    return display;
  }

  setupCodeAvailable(): boolean {
    return !this.hasAccounts() && this.setupCode !== null && this.setupCode.expiresAt > this.now();
  }

  /** Create the first account with the setup code, and sign it in. */
  async setup(
    input: { code: string; name: string; password: string },
    meta: SessionMeta,
  ): Promise<SignInResult> {
    return this.serialize(async () => {
      if (this.hasAccounts()) {
        throw new AccountError(
          'setup_closed',
          'This Gezel already has an account. Sign in instead.',
        );
      }
      const pending = this.setupCode;
      const supplied = normalizeSetupCode(input.code);
      const retry = this.throttle.retryAfterSeconds('setup', meta.address);
      if (retry > 0) {
        throw new AccountError('throttled', 'Too many tries. Wait a moment and try again.', retry);
      }
      if (!pending || pending.expiresAt <= this.now() || supplied !== pending.normalized) {
        this.throttle.recordFailure('setup', meta.address);
        throw new AccountError(
          'setup_code_invalid',
          'That setup link has expired or was already used. Get a new one from the logs.',
        );
      }
      this.setupCode = null;
      const account = await this.insertAccount(input.name, input.password);
      return this.openSession(account, meta);
    });
  }

  /**
   * Create the owner from a deployer-supplied name and password (a Docker
   * secret), only while no account exists. Returns null when one already did.
   */
  async seedOwner(name: string, password: string): Promise<Account | null> {
    return this.serialize(async () => {
      if (this.hasAccounts()) return null;
      this.setupCode = null;
      return toPublic(await this.insertAccount(name, password));
    });
  }

  // ── account management ─────────────────────────────────────────────────

  async create(input: { name: string; password: string }): Promise<Account> {
    return this.serialize(async () => {
      const account = await this.insertAccount(input.name, input.password);
      this.setupCode = null;
      return toPublic(account);
    });
  }

  async update(id: string, change: { name?: string; disabled?: boolean }): Promise<Account> {
    return this.serialize(async () => {
      const account = this.require(id);
      const next: StoredAccount = { ...account };
      if (change.name !== undefined && change.name.trim() !== account.name) {
        this.assertNameFree(change.name, id);
        next.name = change.name.trim();
      }
      let disabledNow = false;
      let enabledNow = false;
      if (change.disabled === true && !account.disabledAt) {
        this.assertAnotherAdmin(id);
        next.disabledAt = iso(this.now());
        disabledNow = true;
      } else if (change.disabled === false && account.disabledAt) {
        next.disabledAt = undefined;
        enabledNow = true;
      }
      next.updatedAt = iso(this.now());
      await this.commitAccounts(new Map(this.accounts).set(id, next));
      if (disabledNow) await this.dropSessions((s) => s.accountId === id);
      if (next.name !== account.name) {
        await this.history('account.updated', `Account renamed to ${next.name}`, next);
      }
      if (disabledNow)
        await this.history('account.disabled', `${next.name} can no longer sign in`, next);
      if (enabledNow) await this.history('account.enabled', `${next.name} can sign in again`, next);
      return toPublic(next);
    });
  }

  /**
   * Set an account's password. With `currentPassword` (people changing their
   * own), it must match. Other sessions of the account are signed out; the
   * caller's own session, when given, stays.
   */
  async setPassword(
    id: string,
    password: string,
    opts: { currentPassword?: string; requireCurrent?: boolean; keepSessionId?: string } = {},
  ): Promise<Account> {
    return this.serialize(async () => {
      const account = this.require(id);
      if (opts.requireCurrent) {
        const ok =
          opts.currentPassword !== undefined &&
          (await verifyPassword(opts.currentPassword, account.passwordHash));
        if (!ok) throw new AccountError('wrong_password', 'The current password is not right.');
      }
      this.assertPasswordShape(password);
      const at = iso(this.now());
      const next: StoredAccount = {
        ...account,
        passwordHash: await hashPassword(password, this.scrypt),
        passwordChangedAt: at,
        updatedAt: at,
      };
      await this.commitAccounts(new Map(this.accounts).set(id, next));
      await this.dropSessions((s) => s.accountId === id && s.id !== opts.keepSessionId);
      await this.history('account.password.changed', `${next.name}'s password was changed`, next);
      return toPublic(next);
    });
  }

  async remove(id: string): Promise<void> {
    return this.serialize(async () => {
      const account = this.require(id);
      this.assertAnotherAdmin(id);
      const next = new Map(this.accounts);
      next.delete(id);
      await this.commitAccounts(next);
      await this.dropSessions((s) => s.accountId === id);
      await this.history('account.removed', `${account.name} was removed`, account);
    });
  }

  // ── sign-in and sessions ───────────────────────────────────────────────

  async signIn(
    input: { name: string; password: string },
    meta: SessionMeta,
  ): Promise<SignInResult> {
    const retry = this.throttle.retryAfterSeconds(input.name, meta.address);
    if (retry > 0) {
      throw new AccountError('throttled', 'Too many tries. Wait a moment and try again.', retry);
    }
    const key = nameKey(input.name);
    const account = [...this.accounts.values()].find((a) => nameKey(a.name) === key);
    // A missing name costs the same as a wrong password, so the response
    // time does not tell anyone which names exist.
    let ok = false;
    if (account) {
      ok = await verifyPassword(input.password, account.passwordHash);
    } else {
      await verifyPassword(input.password, await dummyPasswordHash(this.scrypt));
    }
    const usable = ok && account && !account.disabledAt && isKnownAccountRole(account.role);
    if (!usable || !account) {
      this.throttle.recordFailure(input.name, meta.address);
      await this.logFailure(input.name, meta.address);
      throw new AccountError('sign_in_failed', 'That name or password is not right.');
    }
    this.throttle.recordSuccess(input.name, meta.address);
    return this.serialize(async () => {
      let current = this.accounts.get(account.id) ?? account;
      if (needsRehash(current.passwordHash, this.scrypt)) {
        current = { ...current, passwordHash: await hashPassword(input.password, this.scrypt) };
      }
      return this.openSession(current, meta);
    });
  }

  async signOut(token: string): Promise<boolean> {
    return this.serialize(async () => {
      const hash = hashToken(token);
      const session = this.sessionsByHash.get(hash);
      if (!session) return false;
      await this.dropSessions((s) => s.tokenHash === hash);
      const account = this.accounts.get(session.accountId);
      if (account) await this.history('account.signed-out', `${account.name} signed out`, account);
      return true;
    });
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    return this.serialize(async () => {
      const before = this.sessionsByHash.size;
      await this.dropSessions((s) => s.id === sessionId);
      return this.sessionsByHash.size < before;
    });
  }

  async revokeAll(accountId: string, exceptSessionId?: string): Promise<number> {
    return this.serialize(async () => {
      const before = this.sessionsByHash.size;
      await this.dropSessions((s) => s.accountId === accountId && s.id !== exceptSessionId);
      return before - this.sessionsByHash.size;
    });
  }

  /** Write any slid `lastSeenAt` values now. Called on shutdown. */
  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    await this.serialize(() => this.commitSessions(new Map(this.sessionsByHash)));
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async insertAccount(name: string, password: string): Promise<StoredAccount> {
    this.assertNameFree(name);
    this.assertPasswordShape(password);
    const at = iso(this.now());
    const account: StoredAccount = {
      id: randomUUID(),
      name: name.trim(),
      role: DEFAULT_ACCOUNT_ROLE,
      passwordHash: await hashPassword(password, this.scrypt),
      createdAt: at,
      updatedAt: at,
      passwordChangedAt: at,
    };
    await this.commitAccounts(new Map(this.accounts).set(account.id, account));
    await this.history('account.created', `${account.name} can now sign in`, account);
    return account;
  }

  private async openSession(account: StoredAccount, meta: SessionMeta): Promise<SignInResult> {
    const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const at = this.now();
    const session: StoredSession = {
      id: randomBytes(8).toString('hex'),
      accountId: account.id,
      tokenHash: hashToken(token),
      createdAt: iso(at),
      lastSeenAt: iso(at),
      expiresAt: iso(at + ABSOLUTE_EXPIRY_MS),
      ...(meta.label ? { label: meta.label.slice(0, 120) } : {}),
      ...(meta.address ? { address: meta.address.slice(0, 64) } : {}),
    };
    const updated: StoredAccount = { ...account, lastSignInAt: iso(at) };
    await this.commitAccounts(new Map(this.accounts).set(account.id, updated));
    await this.commitSessions(new Map(this.sessionsByHash).set(session.tokenHash, session));
    this.lastWritten.set(session.id, at);
    await this.history('account.signed-in', `${account.name} signed in`, account, {
      ...(meta.label ? { label: meta.label } : {}),
      ...(meta.address ? { address: meta.address } : {}),
    });
    return { token, expiresAt: iso(this.sessionExpiresAt(session)), account: toPublic(updated) };
  }

  private sessionExpiresAt(session: StoredSession): number {
    return Math.min(
      Date.parse(session.expiresAt),
      Date.parse(session.lastSeenAt) + SLIDING_EXPIRY_MS,
    );
  }

  private sessionAlive(session: StoredSession, at: number): boolean {
    return this.sessionExpiresAt(session) > at;
  }

  private require(id: string): StoredAccount {
    const account = this.accounts.get(id);
    if (!account) throw new AccountError('not_found', 'There is no such account.');
    return account;
  }

  private assertNameFree(name: string, exceptId?: string): void {
    const key = nameKey(name);
    for (const account of this.accounts.values()) {
      if (account.id !== exceptId && nameKey(account.name) === key) {
        throw new AccountError('name_taken', `Someone is already called ${account.name}.`);
      }
    }
  }

  private assertPasswordShape(password: string): void {
    if (
      password.length < ACCOUNT_PASSWORD_MIN_LENGTH ||
      password.length > ACCOUNT_PASSWORD_MAX_LENGTH
    ) {
      throw new AccountError(
        'invalid_password',
        `Use at least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters for the password.`,
      );
    }
  }

  /** At least one admin who can sign in must remain. */
  private assertAnotherAdmin(leavingId: string): void {
    const others = [...this.accounts.values()].filter(
      (a) => a.id !== leavingId && !a.disabledAt && accountCanManageAccounts(a.role),
    );
    if (others.length === 0) {
      throw new AccountError(
        'last_admin',
        'At least one account that can manage accounts has to remain. Add another one first.',
      );
    }
  }

  private async dropSessions(match: (session: StoredSession) => boolean): Promise<void> {
    const next = new Map(this.sessionsByHash);
    for (const [hash, session] of next) if (match(session)) next.delete(hash);
    if (next.size !== this.sessionsByHash.size) await this.commitSessions(next);
  }

  private async commitAccounts(next: Map<string, StoredAccount>): Promise<void> {
    await writeAccounts(this.accountsPath, [...next.values()]);
    this.accounts = next;
  }

  private async commitSessions(next: Map<string, StoredSession>): Promise<void> {
    const at = this.now();
    const alive = [...next.values()].filter((s) => this.sessionAlive(s, at));
    await writeSessions(this.sessionsPath, alive);
    this.sessionsByHash = new Map(alive.map((s) => [s.tokenHash, s]));
    for (const session of alive) this.lastWritten.set(session.id, Date.parse(session.lastSeenAt));
  }

  private scheduleSessionFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.serialize(() => this.commitSessions(new Map(this.sessionsByHash))).catch((err) =>
        this.opts.warn?.(
          `[accounts] could not save session activity: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }, 5_000);
    this.flushTimer.unref?.();
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async logFailure(name: string, address: string | undefined): Promise<void> {
    const key = `${nameKey(name)}|${address ?? ''}`;
    const at = this.now();
    if (at - (this.failureLoggedAt.get(key) ?? 0) < FAILURE_LOG_INTERVAL_MS) return;
    this.failureLoggedAt.set(key, at);
    if (this.failureLoggedAt.size > 1_000) this.failureLoggedAt.clear();
    await this.opts.history
      ?.log({
        kind: 'account.sign-in.failed',
        summary: `A sign-in as "${name.slice(0, 64)}" failed`,
        details: { name: name.slice(0, 64), ...(address ? { address } : {}) },
      })
      .catch(() => {});
  }

  private async history(
    kind: HistoryEvent['kind'],
    summary: string,
    account: StoredAccount,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.opts.history
      ?.log({ kind, summary, details: { accountId: account.id, name: account.name, ...extra } })
      .catch(() => {});
  }
}
