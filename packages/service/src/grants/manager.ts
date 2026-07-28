import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { pendingGrantsFile as defaultPendingGrantsFile } from '@bendyline/gezel/paths';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';
import { type TokenStore, assertGrantableAppToken } from '../http/token-store.js';

export const PENDING_GRANT_TTL_MS = 10 * 60_000;
export const APPROVED_GRANT_DELIVERY_TTL_MS = 5 * 60_000;
export const MAX_PENDING_GRANTS = 32;
export const MAX_VERIFICATION_ATTEMPTS = 5;

const VERIFICATION_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const INFERENCE_ONLY_SCOPES = new Set(['openai', 'remote-inference']);

/**
 * Status of a `/v1/apps/register` consent request.
 *
 *  - `pending`  — waiting for the user to approve/deny in the Connected
 *                 Apps UI (or for the headless `GEZEL_AUTOAPPROVE_APPS`
 *                 path at request time).
 *  - `approved` — the user (or auto-approve) accepted; an unclaimed token
 *                 is delivered once, then removed from grant storage.
 *  - `denied`   — the user rejected. The polling app should surface a
 *                 clear "user declined the connection" error.
 *  - `expired`  — the request or its unclaimed token exceeded its TTL.
 */
export type GrantStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface GrantRequest {
  id: string;
  appId: string;
  appName: string;
  scopes: string[];
  iconUrl?: string;
  status: GrantStatus;
  createdAt: number;
  decidedAt?: number;
  expiresAt?: number;
  tokenRetrievedAt?: number;
  /**
   * Whether approval requires the user to enter the requester-visible code.
   * The plaintext code is never attached to this record or persisted.
   */
  verificationRequired?: boolean;
  /** Random salt and digest for the short-lived verification code. */
  verificationCodeSalt?: string;
  verificationCodeHash?: string;
  verificationFailedAttempts?: number;
  /**
   * The bearer token issued to the app on approval. Present only until the
   * first successful poll/SSE delivery, then atomically removed.
   */
  token?: string;
  /** Durable transaction token while TokenStore is issuing this grant. */
  issuingToken?: string;
  /**
   * `'device'` for grants opened by the remote-model-execution pairing flow
   * (a paired gezel daemon), `'app'`/absent for ordinary third-party apps.
   * Drives the "Paired devices" section in the Connected Apps UI and tags the
   * issued token so the `/v1/remote/*` handlers can namespace per origin.
   */
  kind?: 'app' | 'device';
  /** The paired device's identity public key (SPKI PEM), captured at register. */
  deviceIdentityPubKey?: string;
}

export type GrantEvent =
  | { type: 'grant_requested'; grant: GrantRequest }
  | { type: 'grant_decided'; grant: GrantRequest };

export interface GrantRequestInput {
  appId: string;
  appName: string;
  scopes: string[];
  /** Request code verification even when every requested scope is inference-only. */
  requireVerificationCode?: boolean;
  iconUrl?: string;
  kind?: 'app' | 'device';
  deviceIdentityPubKey?: string;
}

export interface GrantRequestCreated {
  grant: GrantRequest;
  /**
   * Requester-visible code. Returned exactly once from `request()` and never
   * retained in manager state or written to `pending-grants.json`.
   */
  verificationCode?: string;
}

export interface GrantManager {
  /**
   * Create a new pending grant request. If `GEZEL_AUTOAPPROVE_APPS`
   * contains `appId`, the grant is auto-approved (token issued, status
   * set to `approved`) at request time. Persists.
   */
  request(input: GrantRequestInput): Promise<GrantRequestCreated>;
  get(id: string): GrantRequest | null;
  list(): GrantRequest[];
  /** Expire stale pending/unclaimed approvals and revoke undelivered tokens. */
  sweepExpired(now?: number): Promise<void>;
  /** Claim an approved token exactly once. Returns null after consumption. */
  consumeToken(id: string): Promise<string | null>;
  /**
   * Approve a pending grant. Issues a per-app token via the bound
   * {@link TokenStore} and stamps `decidedAt`. Throws if the grant is
   * not in `pending`.
   */
  approve(id: string, verificationCode?: string): Promise<GrantRequest>;
  /** Deny a pending grant. Throws if the grant is not in `pending`. */
  deny(id: string): Promise<GrantRequest>;
  /**
   * Subscribe to grant lifecycle events. Listener fires synchronously
   * after persistence completes. Returns an unsubscribe function.
   *
   * The SSE route also uses this to push status changes to the polling
   * client.
   */
  subscribe(listener: (event: GrantEvent) => void): () => void;
}

export interface CreateGrantManagerOptions {
  home: string;
  tokenStore: TokenStore;
  /** Override the on-disk file path. Defaults to `<home>/pending-grants.json`. */
  filePath?: string;
  /**
   * Pre-approved app ids. When `request()` is called with an `appId` on
   * this list, the grant goes straight to `approved`. Sourced from
   * `GEZEL_AUTOAPPROVE_APPS` (comma-separated) by callers; tests pass
   * the list directly.
   */
  autoApproveAppIds?: readonly string[];
}

interface PersistedShape {
  version: 1;
  grants: GrantRequest[];
}

export class PendingGrantExistsError extends Error {
  constructor(readonly appId: string) {
    super(`a pending grant already exists for ${appId}`);
    this.name = 'PendingGrantExistsError';
  }
}

export class TooManyPendingGrantsError extends Error {
  constructor() {
    super(`too many pending grants (maximum ${MAX_PENDING_GRANTS})`);
    this.name = 'TooManyPendingGrantsError';
  }
}

export class VerificationCodeRequiredError extends Error {
  constructor() {
    super('a verification code is required to approve this grant');
    this.name = 'VerificationCodeRequiredError';
  }
}

export class InvalidVerificationCodeError extends Error {
  constructor(readonly attemptsRemaining: number) {
    super('the verification code is incorrect');
    this.name = 'InvalidVerificationCodeError';
  }
}

export class VerificationAttemptsExceededError extends Error {
  constructor() {
    super('too many incorrect verification-code attempts');
    this.name = 'VerificationAttemptsExceededError';
  }
}

export class GrantExpiredError extends Error {
  constructor() {
    super('the grant has expired');
    this.name = 'GrantExpiredError';
  }
}

/**
 * Stateful scopes require a requester-visible verification code. Keeping the
 * exemptions as an inference-only allowlist makes future privileged scopes
 * opt into verification automatically.
 */
export function requiresGrantVerification(scopes: readonly string[]): boolean {
  return scopes.some((scope) => !INFERENCE_ONLY_SCOPES.has(scope));
}

export function normalizeVerificationCode(code: string): string | null {
  const normalized = code.replace(/[-\s]/g, '').toUpperCase();
  if (normalized.length !== 6) return null;
  for (const char of normalized) {
    if (!VERIFICATION_CODE_ALPHABET.includes(char)) return null;
  }
  return normalized;
}

function generateVerificationCode(): string {
  let raw = '';
  while (raw.length < 6) {
    for (const byte of randomBytes(8)) {
      // Reject the top 16 byte values so modulo 30 remains unbiased.
      if (byte >= 240) continue;
      raw += VERIFICATION_CODE_ALPHABET[byte % VERIFICATION_CODE_ALPHABET.length];
      if (raw.length === 6) break;
    }
  }
  return `${raw.slice(0, 3)}-${raw.slice(3)}`;
}

function hashVerificationCode(salt: string, normalizedCode: string): Buffer {
  return createHash('sha256')
    .update(salt, 'base64url')
    .update('\0')
    .update(normalizedCode, 'ascii')
    .digest();
}

function codeMatches(grant: GrantRequest, suppliedCode: string): boolean {
  const normalized = normalizeVerificationCode(suppliedCode);
  if (!normalized || !grant.verificationCodeSalt || !grant.verificationCodeHash) return false;
  const actual = hashVerificationCode(grant.verificationCodeSalt, normalized);
  let expected: Buffer;
  try {
    expected = Buffer.from(grant.verificationCodeHash, 'base64url');
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Parse the `GEZEL_AUTOAPPROVE_APPS` env var. Comma-separated, trimmed,
 * empty entries dropped. Documented as a CI / scripting bypass — not the
 * default path.
 */
export function parseAutoApproveAppIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function createGrantManager(opts: CreateGrantManagerOptions): Promise<GrantManager> {
  const filePath = opts.filePath ?? defaultPendingGrantsFile(opts.home);
  const autoApprove = new Set(opts.autoApproveAppIds ?? []);

  const byId = new Map<string, GrantRequest>();
  const persisted = await loadPersisted(filePath);
  for (const g of persisted) byId.set(g.id, g);

  const listeners = new Set<(event: GrantEvent) => void>();
  const persist = async (): Promise<void> => {
    const snapshot: PersistedShape = {
      version: 1,
      grants: Array.from(byId.values()),
    };
    await writeSecurityJson(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await chmod(filePath, 0o600).catch(() => {});
  };

  let mutationChain: Promise<void> = Promise.resolve();
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(fn);
    mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // Recover a crash between marking a grant as issuing and committing its
  // final approved state. TokenStore is already loaded, so its durable record
  // tells us which side of the transaction completed.
  let recovered = false;
  for (const grant of byId.values()) {
    if (!grant.issuingToken) continue;
    const issued = opts.tokenStore.list().find((token) => token.appId === grant.appId);
    if (issued?.token === grant.issuingToken) {
      grant.status = 'approved';
      grant.decidedAt ??= Date.now();
      grant.token = issued.token;
      grant.expiresAt ??= grant.decidedAt + APPROVED_GRANT_DELIVERY_TTL_MS;
      delete grant.verificationCodeSalt;
      delete grant.verificationCodeHash;
      delete grant.verificationFailedAttempts;
    }
    delete grant.issuingToken;
    recovered = true;
  }
  if (recovered) await persist();

  const emit = (event: GrantEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Listener crashes shouldn't kill the manager. The caller of
        // subscribe owns making their listener safe; we just isolate.
      }
    }
  };

  const approveGrant = async (grant: GrantRequest): Promise<GrantRequest> => {
    assertGrantableAppToken(grant);
    const verificationState = {
      salt: grant.verificationCodeSalt,
      hash: grant.verificationCodeHash,
      failedAttempts: grant.verificationFailedAttempts,
    };
    grant.issuingToken = randomBytes(32).toString('base64url');
    await persist();
    let issued: ReturnType<TokenStore['list']>[number];
    try {
      issued = await opts.tokenStore.issue({
        appId: grant.appId,
        appName: grant.appName,
        scopes: grant.scopes,
        token: grant.issuingToken,
        ...(grant.kind === 'device' ? { kind: 'device' as const, deviceId: grant.appId } : {}),
      });
    } catch (err) {
      delete grant.issuingToken;
      await persist().catch(() => undefined);
      throw err;
    }

    grant.status = 'approved';
    grant.decidedAt = Date.now();
    grant.expiresAt = grant.decidedAt + APPROVED_GRANT_DELIVERY_TTL_MS;
    grant.token = issued.token;
    delete grant.issuingToken;
    delete grant.verificationCodeSalt;
    delete grant.verificationCodeHash;
    delete grant.verificationFailedAttempts;
    try {
      await persist();
    } catch (err) {
      let revoked = false;
      try {
        revoked = await opts.tokenStore.revoke(grant.appId);
      } catch {
        // Keep the durable issuing marker when rollback itself cannot be
        // committed. On restart, recovery can then reconcile the exact token
        // instead of leaving a live, undiscoverable credential orphaned.
      }
      grant.status = 'pending';
      delete grant.decidedAt;
      grant.expiresAt = grant.createdAt + PENDING_GRANT_TTL_MS;
      delete grant.token;
      if (verificationState.salt) grant.verificationCodeSalt = verificationState.salt;
      if (verificationState.hash) grant.verificationCodeHash = verificationState.hash;
      if (verificationState.failedAttempts !== undefined) {
        grant.verificationFailedAttempts = verificationState.failedAttempts;
      }
      if (revoked) delete grant.issuingToken;
      await persist().catch(() => undefined);
      throw err;
    }
    return grant;
  };

  return {
    async request(input: GrantRequestInput): Promise<GrantRequestCreated> {
      return mutate(async () => {
        assertGrantableAppToken(input);
        if (
          Array.from(byId.values()).some(
            (grant) => grant.appId === input.appId && grant.status === 'pending',
          )
        ) {
          throw new PendingGrantExistsError(input.appId);
        }
        if (
          Array.from(byId.values()).filter((grant) => grant.status === 'pending').length >=
          MAX_PENDING_GRANTS
        ) {
          throw new TooManyPendingGrantsError();
        }
        const createdAt = Date.now();
        const verificationRequired =
          input.requireVerificationCode === true || requiresGrantVerification(input.scopes);
        const verificationCode = verificationRequired ? generateVerificationCode() : undefined;
        const normalizedCode = verificationCode
          ? normalizeVerificationCode(verificationCode)
          : undefined;
        const verificationCodeSalt = verificationRequired
          ? randomBytes(16).toString('base64url')
          : undefined;
        const grant: GrantRequest = {
          id: randomUUID(),
          appId: input.appId,
          appName: input.appName,
          scopes: [...input.scopes],
          ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.deviceIdentityPubKey
            ? { deviceIdentityPubKey: input.deviceIdentityPubKey }
            : {}),
          status: 'pending',
          createdAt,
          expiresAt: createdAt + PENDING_GRANT_TTL_MS,
          ...(verificationRequired
            ? {
                verificationRequired: true,
                verificationCodeSalt,
                verificationCodeHash: hashVerificationCode(
                  verificationCodeSalt!,
                  normalizedCode!,
                ).toString('base64url'),
                verificationFailedAttempts: 0,
              }
            : {}),
        };
        byId.set(grant.id, grant);
        try {
          await persist();
        } catch (err) {
          byId.delete(grant.id);
          throw err;
        }
        emit({ type: 'grant_requested', grant });
        if (autoApprove.has(input.appId)) {
          try {
            await approveGrant(grant);
          } catch (err) {
            // A retained marker means token rollback failed. Preserve that
            // recoverable transaction instead of converting it to a denial
            // and orphaning the already-issued credential.
            if (grant.issuingToken) throw err;
            grant.status = 'denied';
            grant.decidedAt = Date.now();
            delete grant.verificationCodeSalt;
            delete grant.verificationCodeHash;
            delete grant.verificationFailedAttempts;
            await persist();
          }
          emit({ type: 'grant_decided', grant });
        }
        return {
          grant,
          ...(verificationCode && grant.status === 'pending' ? { verificationCode } : {}),
        };
      });
    },

    get(id: string): GrantRequest | null {
      return byId.get(id) ?? null;
    },

    list(): GrantRequest[] {
      return Array.from(byId.values());
    },

    async sweepExpired(now = Date.now()): Promise<void> {
      return mutate(async () => {
        const prior = new Map<string, GrantRequest>();
        for (const grant of byId.values()) {
          const awaitsDecision = grant.status === 'pending';
          const awaitsDelivery = grant.status === 'approved' && Boolean(grant.token);
          if (
            (awaitsDecision || awaitsDelivery) &&
            grant.expiresAt !== undefined &&
            grant.expiresAt <= now
          ) {
            prior.set(grant.id, { ...grant, scopes: [...grant.scopes] });
          }
        }
        if (prior.size === 0) return;

        // An unclaimed approval owns a live bearer token. Revoke those tokens
        // before committing the expired grant snapshot so a token-store write
        // failure can never leave an active credential orphaned from its grant.
        const revoked: GrantRequest[] = [];
        try {
          for (const grant of prior.values()) {
            if (grant.status === 'approved' && grant.token) {
              if (await opts.tokenStore.revoke(grant.appId)) revoked.push(grant);
            }
          }
          for (const id of prior.keys()) {
            const grant = byId.get(id)!;
            grant.status = 'expired';
            grant.decidedAt ??= now;
            delete grant.expiresAt;
            delete grant.token;
            delete grant.issuingToken;
            delete grant.verificationCodeSalt;
            delete grant.verificationCodeHash;
            delete grant.verificationFailedAttempts;
          }
          await persist();
        } catch (error) {
          for (const [id, grant] of prior) byId.set(id, grant);
          const restorationErrors: unknown[] = [];
          try {
            await persist();
          } catch (restoreError) {
            restorationErrors.push(restoreError);
          }
          for (const grant of revoked) {
            try {
              await opts.tokenStore.issue({
                appId: grant.appId,
                appName: grant.appName,
                scopes: grant.scopes,
                token: grant.token,
                ...(grant.kind === 'device'
                  ? { kind: 'device' as const, deviceId: grant.appId }
                  : {}),
              });
            } catch (restoreError) {
              restorationErrors.push(restoreError);
            }
          }
          if (restorationErrors.length > 0) {
            throw new AggregateError(
              [error, ...restorationErrors],
              'grant expiry failed and could not be fully rolled back',
            );
          }
          throw error;
        }
        for (const id of prior.keys()) {
          emit({ type: 'grant_decided', grant: byId.get(id)! });
        }
      });
    },

    async consumeToken(id: string): Promise<string | null> {
      return mutate(async () => {
        const grant = byId.get(id);
        if (!grant || grant.status !== 'approved' || !grant.token) return null;
        const token = grant.token;
        const expiresAt = grant.expiresAt;
        delete grant.token;
        delete grant.expiresAt;
        grant.tokenRetrievedAt = Date.now();
        try {
          await persist();
        } catch (error) {
          grant.token = token;
          if (expiresAt !== undefined) grant.expiresAt = expiresAt;
          delete grant.tokenRetrievedAt;
          throw error;
        }
        return token;
      });
    },

    async approve(id: string, verificationCode?: string): Promise<GrantRequest> {
      return mutate(async () => {
        const grant = byId.get(id);
        if (!grant) throw new Error(`grant not found: ${id}`);
        if (grant.status !== 'pending' || grant.issuingToken) {
          throw new Error(`grant already decided: ${grant.status}`);
        }
        if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) {
          const prior = { ...grant, scopes: [...grant.scopes] };
          grant.status = 'expired';
          grant.decidedAt = Date.now();
          delete grant.expiresAt;
          delete grant.verificationCodeSalt;
          delete grant.verificationCodeHash;
          delete grant.verificationFailedAttempts;
          try {
            await persist();
          } catch (error) {
            byId.set(grant.id, prior);
            throw error;
          }
          emit({ type: 'grant_decided', grant });
          throw new GrantExpiredError();
        }
        if (grant.verificationRequired) {
          if (!verificationCode) throw new VerificationCodeRequiredError();
          if (!codeMatches(grant, verificationCode)) {
            const priorAttempts = grant.verificationFailedAttempts ?? 0;
            grant.verificationFailedAttempts = priorAttempts + 1;
            const attemptsRemaining = Math.max(
              0,
              MAX_VERIFICATION_ATTEMPTS - grant.verificationFailedAttempts,
            );
            if (attemptsRemaining === 0) {
              const verificationCodeSalt = grant.verificationCodeSalt;
              const verificationCodeHash = grant.verificationCodeHash;
              grant.status = 'expired';
              grant.decidedAt = Date.now();
              delete grant.expiresAt;
              delete grant.verificationCodeSalt;
              delete grant.verificationCodeHash;
              try {
                await persist();
              } catch (error) {
                grant.status = 'pending';
                delete grant.decidedAt;
                grant.expiresAt = grant.createdAt + PENDING_GRANT_TTL_MS;
                grant.verificationFailedAttempts = priorAttempts;
                if (verificationCodeSalt) grant.verificationCodeSalt = verificationCodeSalt;
                if (verificationCodeHash) grant.verificationCodeHash = verificationCodeHash;
                throw error;
              }
              emit({ type: 'grant_decided', grant });
              throw new VerificationAttemptsExceededError();
            }
            try {
              await persist();
            } catch (error) {
              grant.verificationFailedAttempts = priorAttempts;
              throw error;
            }
            throw new InvalidVerificationCodeError(attemptsRemaining);
          }
        }
        await approveGrant(grant);
        emit({ type: 'grant_decided', grant });
        return grant;
      });
    },

    async deny(id: string): Promise<GrantRequest> {
      return mutate(async () => {
        const grant = byId.get(id);
        if (!grant) throw new Error(`grant not found: ${id}`);
        if (grant.status !== 'pending' || grant.issuingToken) {
          throw new Error(`grant already decided: ${grant.status}`);
        }
        const verificationState = {
          salt: grant.verificationCodeSalt,
          hash: grant.verificationCodeHash,
          failedAttempts: grant.verificationFailedAttempts,
        };
        grant.status = 'denied';
        grant.decidedAt = Date.now();
        delete grant.verificationCodeSalt;
        delete grant.verificationCodeHash;
        delete grant.verificationFailedAttempts;
        try {
          await persist();
        } catch (err) {
          grant.status = 'pending';
          delete grant.decidedAt;
          if (verificationState.salt) grant.verificationCodeSalt = verificationState.salt;
          if (verificationState.hash) grant.verificationCodeHash = verificationState.hash;
          if (verificationState.failedAttempts !== undefined) {
            grant.verificationFailedAttempts = verificationState.failedAttempts;
          }
          throw err;
        }
        emit({ type: 'grant_decided', grant });
        return grant;
      });
    },

    subscribe(listener: (event: GrantEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

async function loadPersisted(filePath: string): Promise<GrantRequest[]> {
  return (await readSecurityJson(filePath, 'pending grants', (raw) => decodePersisted(raw))) ?? [];
}

function decodePersisted(raw: string): GrantRequest[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('expected an object');
  const shape = parsed as Partial<PersistedShape>;
  if (shape.version !== 1 || !Array.isArray(shape.grants)) {
    throw new Error('unsupported version or missing grants array');
  }
  const grants: GrantRequest[] = [];
  for (const entry of shape.grants) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid grant record');
    const e = entry as Partial<GrantRequest>;
    if (
      typeof e.id !== 'string' ||
      typeof e.appId !== 'string' ||
      typeof e.appName !== 'string' ||
      !Array.isArray(e.scopes) ||
      !e.scopes.every((scope): scope is string => typeof scope === 'string') ||
      typeof e.status !== 'string' ||
      typeof e.createdAt !== 'number'
    ) {
      throw new Error('invalid grant record fields');
    }
    const status = e.status as GrantStatus;
    if (
      status !== 'pending' &&
      status !== 'approved' &&
      status !== 'denied' &&
      status !== 'expired'
    ) {
      throw new Error(`unknown grant status: ${status}`);
    }
    const scopes = e.scopes as string[];
    try {
      assertGrantableAppToken({ appId: e.appId, scopes });
    } catch (error) {
      throw new Error(`invalid grant authority for ${e.appId}`, { cause: error });
    }
    // An unknown persisted kind is not an ordinary app. Reject it rather
    // than silently dropping the discriminator and widening its meaning.
    if (e.kind !== undefined && e.kind !== 'app' && e.kind !== 'device') {
      throw new Error(`unknown grant kind for ${e.appId}`);
    }
    const token = typeof e.token === 'string' && e.token.length > 0 ? e.token : undefined;
    const verificationRequired =
      e.verificationRequired === true || requiresGrantVerification(scopes);
    const hasVerificationProof =
      typeof e.verificationCodeSalt === 'string' &&
      e.verificationCodeSalt.length > 0 &&
      typeof e.verificationCodeHash === 'string' &&
      e.verificationCodeHash.length > 0;
    const missingRequiredProof =
      status === 'pending' && verificationRequired && !hasVerificationProof;
    const decodedStatus = missingRequiredProof ? 'expired' : status;
    const expiresAt =
      typeof e.expiresAt === 'number'
        ? e.expiresAt
        : decodedStatus === 'pending'
          ? e.createdAt + PENDING_GRANT_TTL_MS
          : decodedStatus === 'approved' && token
            ? (e.decidedAt ?? e.createdAt) + APPROVED_GRANT_DELIVERY_TTL_MS
            : undefined;
    grants.push({
      id: e.id,
      appId: e.appId,
      appName: e.appName,
      scopes,
      ...(typeof e.iconUrl === 'string' ? { iconUrl: e.iconUrl } : {}),
      status: decodedStatus,
      createdAt: e.createdAt,
      ...(typeof e.decidedAt === 'number'
        ? { decidedAt: e.decidedAt }
        : missingRequiredProof
          ? { decidedAt: Date.now() }
          : {}),
      ...(expiresAt !== undefined && !missingRequiredProof ? { expiresAt } : {}),
      ...(typeof e.tokenRetrievedAt === 'number' ? { tokenRetrievedAt: e.tokenRetrievedAt } : {}),
      ...(decodedStatus === 'approved' && token !== undefined ? { token } : {}),
      ...(decodedStatus === 'pending' && typeof e.issuingToken === 'string'
        ? { issuingToken: e.issuingToken }
        : {}),
      ...(verificationRequired ? { verificationRequired: true } : {}),
      ...(decodedStatus === 'pending' && hasVerificationProof
        ? {
            verificationCodeSalt: e.verificationCodeSalt,
            verificationCodeHash: e.verificationCodeHash,
            verificationFailedAttempts:
              typeof e.verificationFailedAttempts === 'number'
                ? Math.max(0, Math.floor(e.verificationFailedAttempts))
                : 0,
          }
        : {}),
      ...(e.kind === 'app' || e.kind === 'device' ? { kind: e.kind } : {}),
      ...(typeof e.deviceIdentityPubKey === 'string'
        ? { deviceIdentityPubKey: e.deviceIdentityPubKey }
        : {}),
    });
  }
  return grants;
}
