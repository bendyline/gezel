import { randomBytes, randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { pendingGrantsFile as defaultPendingGrantsFile } from '@bendyline/gezel/paths';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';
import { type TokenStore, assertGrantableAppToken } from '../http/token-store.js';

export const PENDING_GRANT_TTL_MS = 10 * 60_000;
export const APPROVED_GRANT_DELIVERY_TTL_MS = 5 * 60_000;
export const MAX_PENDING_GRANTS = 32;

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
  iconUrl?: string;
  kind?: 'app' | 'device';
  deviceIdentityPubKey?: string;
}

export interface GrantManager {
  /**
   * Create a new pending grant request. If `GEZEL_AUTOAPPROVE_APPS`
   * contains `appId`, the grant is auto-approved (token issued, status
   * set to `approved`) at request time. Persists.
   */
  request(input: GrantRequestInput): Promise<GrantRequest>;
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
  approve(id: string): Promise<GrantRequest>;
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
      if (revoked) delete grant.issuingToken;
      await persist().catch(() => undefined);
      throw err;
    }
    return grant;
  };

  return {
    async request(input: GrantRequestInput): Promise<GrantRequest> {
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
            await persist();
          }
          emit({ type: 'grant_decided', grant });
        }
        return grant;
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

    async approve(id: string): Promise<GrantRequest> {
      return mutate(async () => {
        const grant = byId.get(id);
        if (!grant) throw new Error(`grant not found: ${id}`);
        if (grant.status !== 'pending' || grant.issuingToken) {
          throw new Error(`grant already decided: ${grant.status}`);
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
        grant.status = 'denied';
        grant.decidedAt = Date.now();
        try {
          await persist();
        } catch (err) {
          grant.status = 'pending';
          delete grant.decidedAt;
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
    const expiresAt =
      typeof e.expiresAt === 'number'
        ? e.expiresAt
        : status === 'pending'
          ? e.createdAt + PENDING_GRANT_TTL_MS
          : status === 'approved' && token
            ? (e.decidedAt ?? e.createdAt) + APPROVED_GRANT_DELIVERY_TTL_MS
            : undefined;
    grants.push({
      id: e.id,
      appId: e.appId,
      appName: e.appName,
      scopes,
      ...(typeof e.iconUrl === 'string' ? { iconUrl: e.iconUrl } : {}),
      status,
      createdAt: e.createdAt,
      ...(typeof e.decidedAt === 'number' ? { decidedAt: e.decidedAt } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(typeof e.tokenRetrievedAt === 'number' ? { tokenRetrievedAt: e.tokenRetrievedAt } : {}),
      ...(status === 'approved' && token !== undefined ? { token } : {}),
      ...(status === 'pending' && typeof e.issuingToken === 'string'
        ? { issuingToken: e.issuingToken }
        : {}),
      ...(e.kind === 'app' || e.kind === 'device' ? { kind: e.kind } : {}),
      ...(typeof e.deviceIdentityPubKey === 'string'
        ? { deviceIdentityPubKey: e.deviceIdentityPubKey }
        : {}),
    });
  }
  return grants;
}
