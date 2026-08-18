import { randomBytes } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { tokensFile as defaultTokensFile } from '@bendyline/gezel/paths';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';

/**
 * The scope vocabulary the daemon recognizes.
 *   - `root`   — the daemon's own per-launch token; full `/api/*` + `/v1/*`.
 *   - `openai` — the public app scope: the OpenAI-compatible `/v1/*` surface.
 *   - `product` — a user-approved external application credential with product
 *                 API access, but no authority to administer other app grants.
 *   - `cli`    — the Gezel CLI's product-access credential. Retained as a
 *                distinct scope so consent copy and audit records identify it.
 *   - `ui`     — first-party UI clients (the embedded renderer / web-UI
 *                token). Admitted to product routes, but not a daemon root
 *                credential; reserved for internal tokens.
 *   - `session` — an ephemeral MCP subprocess token, bound to one
 *                 `{projectId, gezelId}` and filtered by `sessionRouteGuard`.
 *   - `remote-inference` — a paired remote device's token. Reaches ONLY the
 *                inference-only `/v1/remote/*` surface (chat + image/video/
 *                audio generation); gets 403 on every `/api/*` project/fs
 *                route, so a remote client can never touch this host's
 *                projects, sessions, or filesystem.
 *   - `machine-models` — reserved first-party authority for the automatic
 *                user-daemon → machine-engine bridge. Adds model download,
 *                deletion, native binary, and engine-pool management; never
 *                grantable through `/v1/apps/register`.
 * `scopes` stays a `string[]` on records for forward-compat, but app
 * registration validates requests against {@link APP_GRANTABLE_SCOPES}.
 */
export const KNOWN_SCOPES = [
  'root',
  'openai',
  'product',
  'cli',
  'ui',
  'session',
  'remote-inference',
  'machine-models',
] as const;
export type GezelScope = (typeof KNOWN_SCOPES)[number];

/**
 * Scopes an app may REQUEST via `/v1/apps/register`. `openai` and
 * `remote-inference` remain narrow public surfaces. `product` and `cli` are
 * high-authority product-control scopes that require visible approval plus a
 * requester-side verification code, while `root` and `ui` remain reserved
 * daemon-owned credentials.
 */
export const APP_GRANTABLE_SCOPES = ['openai', 'remote-inference', 'product', 'cli'] as const;

/**
 * App id owned by the Settings-managed Codex bridge. TokenStore.issue()
 * intentionally accepts this id because the first-party setup manager mints
 * its credential directly; the public grant flow must reject it so an
 * unauthenticated caller cannot squat the identity before setup runs.
 */
export const CODEX_SETUP_RESERVED_APP_ID = 'gezel.codex.local-model-bridge';

/** App id owned by the Settings-managed OpenCode bridge. Same contract as Codex's. */
export const OPENCODE_SETUP_RESERVED_APP_ID = 'gezel.opencode.local-model-bridge';

/** App id owned by the Settings-managed pi bridge. Same contract as Codex's. */
export const PI_SETUP_RESERVED_APP_ID = 'gezel.pi.local-model-bridge';

/** App id owned by the extension-free VS Code bridge. Same contract as Codex's. */
export const VSCODE_SETUP_RESERVED_APP_ID = 'gezel.vscode.local-model-bridge';

/** App ids owned by the daemon itself rather than the public grant flow. */
export function isReservedTokenAppId(appId: string): boolean {
  return (
    appId === 'root' ||
    appId === 'desktop-client' ||
    appId === 'machine-engine-client' ||
    appId === 'web-ui' ||
    appId.startsWith('session:')
  );
}

/** App ids that callers of the public `/v1/apps` consent flow cannot claim. */
export function isReservedPublicGrantAppId(appId: string): boolean {
  return (
    isReservedTokenAppId(appId) ||
    appId === CODEX_SETUP_RESERVED_APP_ID ||
    appId === OPENCODE_SETUP_RESERVED_APP_ID ||
    appId === PI_SETUP_RESERVED_APP_ID ||
    appId === VSCODE_SETUP_RESERVED_APP_ID
  );
}

export class ReservedPublicGrantAppIdError extends Error {
  constructor(readonly appId: string) {
    super(`token-store: appId is reserved for a first-party integration: ${appId}`);
    this.name = 'ReservedPublicGrantAppIdError';
  }
}

/**
 * Validate the durable, third-party token shape at the security boundary
 * that actually mints it. HTTP validation alone is insufficient: records are
 * also reloaded from disk and GrantManager has non-HTTP callers in tests and
 * headless flows.
 */
export function assertGrantableAppToken(input: { appId: string; scopes: readonly string[] }): void {
  if (isReservedTokenAppId(input.appId)) {
    throw new Error(`token-store: appId is reserved: ${input.appId}`);
  }
  if (
    input.scopes.length === 0 ||
    input.scopes.some((scope) => !(APP_GRANTABLE_SCOPES as readonly string[]).includes(scope))
  ) {
    throw new Error(
      `token-store: invalid app scopes; allowed scopes are ${APP_GRANTABLE_SCOPES.join(', ')}`,
    );
  }
}

/** Validate authority requested specifically through the public consent flow. */
export function assertPublicGrantableAppToken(input: {
  appId: string;
  scopes: readonly string[];
}): void {
  if (isReservedPublicGrantAppId(input.appId)) {
    throw new ReservedPublicGrantAppIdError(input.appId);
  }
  assertGrantableAppToken(input);
}

function isGrantableAppToken(input: { appId: string; scopes: readonly string[] }): boolean {
  try {
    assertGrantableAppToken(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * One authorized bearer token. The root token (ephemeral, rotated every
 * launch) is registered with `appId='root'` and `scopes=['root']`; per-app
 * tokens are issued via {@link TokenStore.issue} with caller-supplied
 * `appId`, `appName`, and a subset of allowed scopes.
 *
 * The `scopes` array is intentionally a `string[]`, not a closed union —
 * adding a new scope later is additive and doesn't break existing records.
 * Today's vocabulary:
 *  - `root`  — full access to every `/api/*` and `/v1/*` route.
 *  - `openai` — `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`,
 *               `/v1/models/ensure`. The coarse public-app scope.
 *  - `product` — user-approved access to the ordinary Gezel product API for
 *                external applications such as the VS Code extension.
 *  - `cli` — user-approved product API access for the Gezel command line.
 *  `product` and `cli` do not satisfy root/UI-only administration guards.
 *
 * Future scopes (`workspace:read`, `github`, etc.) slot in alongside
 * without a migration.
 */
export interface TokenRecord {
  appId: string;
  appName: string;
  scopes: string[];
  token: string;
  createdAt: number;
  lastUsedAt: number;
  /**
   * Session-scoped tokens (a gezel's MCP subprocess) carry the project +
   * gezel the subprocess is bound to. The scope-guard confines such a
   * token to `/api/projects/<projectId>/*` unless `team` is set. Absent on
   * root / ui / app tokens, which carry no project binding.
   */
  projectId?: string;
  gezelId?: string;
  /** Coordinator session (meester/voorman/planner outside a solo job) that
   *  legitimately operates across projects — bypasses the project guard. */
  team?: boolean;
  /**
   * Distinguishes an ordinary third-party app grant (`'app'`, the default
   * when absent) from a paired *device* grant (`'device'`) issued through the
   * remote-model-execution pairing flow. Drives the "Paired devices" section
   * in the Connected Apps UI. Purely a UI/label hint — scope checks don't
   * read it.
   */
  kind?: 'app' | 'device';
  /**
   * For `kind:'device'` records, the paired client's stable device id (its
   * `deviceId` / pairing `appId`). The `/v1/remote/*` handlers read this off
   * the authenticated token to namespace queue affinity keys per origin
   * (`dev:<deviceId>:<sessionId>`) so one tenant's KV prefix can't be served
   * to another. Absent on app/root/ui/session tokens.
   */
  deviceId?: string;
}

export interface IssueTokenInput {
  appId: string;
  appName: string;
  scopes: string[];
  /** Override the generated token. Tests use this; production should not. */
  token?: string;
  /** Mark this a paired-device grant (see {@link TokenRecord.kind}). */
  kind?: 'app' | 'device';
  /** Stable device id for `kind:'device'` grants (see {@link TokenRecord.deviceId}). */
  deviceId?: string;
}

export interface IssueSessionTokenInput {
  /** Stable per-session id, e.g. `session:<sessionId>`. Re-issuing the
   *  same appId REPLACES the prior token (rotation on bridge re-spawn). */
  appId: string;
  appName?: string;
  projectId: string;
  gezelId: string;
  team: boolean;
  /** Override the generated token. Tests only. */
  token?: string;
}

export interface TokenStore {
  /** O(1) bearer-token lookup. Returns `null` for unknown tokens. */
  lookup(token: string): TokenRecord | null;
  /**
   * Mint a new per-app token. Throws if `appId` already has one — callers
   * must {@link revoke} first to rotate. Persists to disk.
   */
  issue(input: IssueTokenInput): Promise<TokenRecord>;
  /**
   * Drop the token for an app. Returns `true` if a record was removed.
   * Persists to disk. Cannot revoke the root token (no-op + returns false).
   */
  revoke(appId: string): Promise<boolean>;
  /**
   * Mint an EPHEMERAL, project-scoped token for a gezel session's MCP
   * subprocess. Never persisted (dies with the daemon); re-issuing the
   * same `appId` replaces the prior record (clean rotation on re-spawn).
   * Synchronous — no disk I/O.
   */
  issueSession(input: IssueSessionTokenInput): TokenRecord;
  /** Drop an ephemeral session token (in-memory only; no disk write). */
  revokeSession(appId: string): void;
  /** Snapshot of all current records. The root token is included. */
  list(): TokenRecord[];
  /**
   * Stamp `lastUsedAt = now` on the matching record (in-memory only — we
   * don't touch disk on every request). Silent no-op for unknown tokens.
   */
  touch(token: string): void;
}

export interface CreateTokenStoreOptions {
  /**
   * Gezel home directory — used to derive the default `tokens.json` path
   * via {@link defaultTokensFile}. Ignored when `filePath` is set.
   */
  home: string;
  /**
   * The ephemeral per-launch root token. Pre-seeded into the store under
   * `appId='root'` with `scopes=['root']`. Not persisted to disk: it
   * rotates on every daemon boot and never leaves process memory. The
   * runtime `auth-token` discovery file contains a separate scoped `ui`
   * credential.
   */
  rootToken: string;
  /** Override the on-disk file path. Defaults to `<home>/tokens.json`. */
  filePath?: string;
  /**
   * Extra per-launch tokens to pre-seed in-memory, with the same
   * lifecycle as {@link rootToken}: they're registered for lookup but
   * **never** written to `tokens.json` (so {@link issue}/{@link revoke}
   * flushes can't accidentally persist them). Used for the web-UI
   * session token (`gezel start --web`) so the one-time browser URL
   * carries a dedicated, rotates-every-boot token instead of root.
   */
  ephemeralTokens?: Array<{
    appId: string;
    appName: string;
    scopes: string[];
    token: string;
  }>;
}

interface PersistedShape {
  version: 1;
  tokens: Array<Omit<TokenRecord, 'lastUsedAt'> & { lastUsedAt?: number }>;
}

/**
 * Build a {@link TokenStore} backed by `<home>/tokens.json` (mode 0600).
 * The root token is registered in-memory; persisted records are loaded
 * and indexed by both `token` (for lookup) and `appId` (for revoke).
 *
 * Writes are serialized through a single promise chain — `issue` and
 * `revoke` can be called concurrently without losing a record.
 */
export async function createTokenStore(opts: CreateTokenStoreOptions): Promise<TokenStore> {
  const filePath = opts.filePath ?? defaultTokensFile(opts.home);
  const byToken = new Map<string, TokenRecord>();
  const byAppId = new Map<string, TokenRecord>();

  // appIds whose records live in-memory only and must never be flushed
  // to disk: the root token plus any caller-supplied ephemeral tokens.
  const ephemeralAppIds = new Set<string>(['root']);

  const rootRecord: TokenRecord = {
    appId: 'root',
    appName: 'Gezel (root)',
    scopes: ['root'],
    token: opts.rootToken,
    createdAt: Date.now(),
    lastUsedAt: 0,
  };
  byToken.set(rootRecord.token, rootRecord);
  byAppId.set(rootRecord.appId, rootRecord);

  for (const e of opts.ephemeralTokens ?? []) {
    ephemeralAppIds.add(e.appId);
    const rec: TokenRecord = {
      appId: e.appId,
      appName: e.appName,
      scopes: [...e.scopes],
      token: e.token,
      createdAt: Date.now(),
      lastUsedAt: 0,
    };
    byToken.set(rec.token, rec);
    byAppId.set(rec.appId, rec);
  }

  const persisted = await loadPersisted(filePath);
  for (const rec of persisted) {
    // Defensive: skip any persisted record that collides with an
    // in-memory record (root or an ephemeral token's appId/token). The
    // ephemeral tokens always win — a stale persisted 'web-ui' from an
    // older build must not shadow this launch's token.
    if (ephemeralAppIds.has(rec.appId)) continue;
    if (byAppId.has(rec.appId)) continue;
    if (byToken.has(rec.token)) continue;
    byToken.set(rec.token, rec);
    byAppId.set(rec.appId, rec);
  }

  const persist = async (): Promise<void> => {
    const snapshot: PersistedShape = {
      version: 1,
      tokens: Array.from(byAppId.values())
        .filter((r) => !ephemeralAppIds.has(r.appId))
        .map(({ appId, appName, scopes, token, createdAt, lastUsedAt, kind, deviceId }) => ({
          appId,
          appName,
          scopes,
          token,
          createdAt,
          ...(lastUsedAt ? { lastUsedAt } : {}),
          ...(kind ? { kind } : {}),
          ...(deviceId ? { deviceId } : {}),
        })),
    };
    await writeSecurityJson(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await chmod(filePath, 0o600).catch(() => {});
  };

  // Serialize the mutation itself, not just its later disk write. Otherwise
  // issue(A) followed immediately by revoke(A) can make issue's queued flush
  // observe the revoked map and return a token that was never durable.
  let mutationChain: Promise<void> = Promise.resolve();
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(fn);
    mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    lookup(token: string): TokenRecord | null {
      return byToken.get(token) ?? null;
    },

    async issue(input: IssueTokenInput): Promise<TokenRecord> {
      return mutate(async () => {
        assertGrantableAppToken(input);
        if (byAppId.has(input.appId)) {
          throw new Error(`token-store: appId already has a token: ${input.appId}`);
        }
        const token = input.token ?? randomBytes(32).toString('base64url');
        if (byToken.has(token)) {
          throw new Error('token-store: token collision (caller-supplied token already in use)');
        }
        const record: TokenRecord = {
          appId: input.appId,
          appName: input.appName,
          scopes: [...input.scopes],
          token,
          createdAt: Date.now(),
          lastUsedAt: 0,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        };
        byToken.set(record.token, record);
        byAppId.set(record.appId, record);
        try {
          await persist();
        } catch (err) {
          byToken.delete(record.token);
          byAppId.delete(record.appId);
          throw err;
        }
        return record;
      });
    },

    async revoke(appId: string): Promise<boolean> {
      return mutate(async () => {
        if (appId === 'root') return false;
        const existing = byAppId.get(appId);
        if (!existing) return false;
        byAppId.delete(appId);
        byToken.delete(existing.token);
        try {
          await persist();
        } catch (err) {
          byAppId.set(existing.appId, existing);
          byToken.set(existing.token, existing);
          throw err;
        }
        return true;
      });
    },

    issueSession(input: IssueSessionTokenInput): TokenRecord {
      if (!input.appId.startsWith('session:') || input.appId.length === 'session:'.length) {
        throw new Error("token-store: session appId must start with 'session:'");
      }
      // Get-or-create, NOT rotate-on-every-call. A gezel's MCP bridge is
      // spawned once with the minted token baked into its `GEZEL_TOKEN`
      // env, but `issueSession` is reached on every `buildSessionOpts`
      // (it's a side effect there) — including the post-spawn prompt
      // refresh (`recomputeSystemMessage`) that re-runs buildSessionOpts
      // purely to recompute the system-message string. A rotating upsert
      // would delete the token the live bridge still holds, 401-ing its
      // next `/api` call (wild-caught: every macro tool call
      // failed `unauthorized`, breaking start_job/start_project fleet-wide).
      //
      // So: keep the token stable for the session's lifetime and only
      // refresh the scope binding in place (project/gezel/team can shift
      // if the session's context changed). Genuine rotation happens via
      // `revokeSession()` on session teardown (reset/resetClient), after
      // which the next call mints fresh. A caller-supplied `token`
      // (tests only) that differs is treated as an explicit rotation.
      const prior = byAppId.get(input.appId);
      if (prior && !prior.scopes.includes('session')) {
        throw new Error(
          `token-store: session appId collides with a non-session token: ${input.appId}`,
        );
      }
      if (prior && (!input.token || input.token === prior.token)) {
        prior.projectId = input.projectId;
        prior.gezelId = input.gezelId;
        prior.team = input.team;
        if (input.appName) prior.appName = input.appName;
        return prior;
      }
      if (prior) {
        byToken.delete(prior.token);
        byAppId.delete(input.appId);
      }
      const token = input.token ?? randomBytes(32).toString('base64url');
      if (byToken.has(token)) {
        throw new Error('token-store: token collision (caller-supplied token already in use)');
      }
      const now = Date.now();
      const record: TokenRecord = {
        appId: input.appId,
        appName: input.appName ?? input.appId,
        scopes: ['session'],
        token,
        createdAt: now,
        lastUsedAt: 0,
        projectId: input.projectId,
        gezelId: input.gezelId,
        team: input.team,
      };
      // Mark ephemeral so flush() never writes it to tokens.json.
      ephemeralAppIds.add(input.appId);
      byToken.set(record.token, record);
      byAppId.set(record.appId, record);
      return record;
    },

    revokeSession(appId: string): void {
      const existing = byAppId.get(appId);
      if (!existing) return;
      byAppId.delete(appId);
      byToken.delete(existing.token);
      ephemeralAppIds.delete(appId);
    },

    list(): TokenRecord[] {
      return Array.from(byAppId.values());
    },

    touch(token: string): void {
      const rec = byToken.get(token);
      if (!rec) return;
      rec.lastUsedAt = Date.now();
    },
  };
}

async function loadPersisted(filePath: string): Promise<TokenRecord[]> {
  return (await readSecurityJson(filePath, 'token store', (raw) => decodePersisted(raw))) ?? [];
}

function decodePersisted(raw: string): TokenRecord[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('expected an object');
  const shape = parsed as Partial<PersistedShape>;
  if (shape.version !== 1 || !Array.isArray(shape.tokens)) {
    throw new Error('unsupported version or missing tokens array');
  }
  const records: TokenRecord[] = [];
  for (const entry of shape.tokens) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid token record');
    const e = entry as Partial<TokenRecord>;
    if (
      typeof e.appId !== 'string' ||
      typeof e.appName !== 'string' ||
      !Array.isArray(e.scopes) ||
      !e.scopes.every((scope): scope is string => typeof scope === 'string') ||
      typeof e.token !== 'string' ||
      typeof e.createdAt !== 'number'
    ) {
      throw new Error('invalid token record fields');
    }
    const scopes = e.scopes as string[];
    // Durable records are third-party grants only. Never resurrect internal
    // root/UI/session authority from a legacy, corrupted, or attacker-edited
    // tokens.json. Unknown token kinds are rejected rather than normalized.
    if (!isGrantableAppToken({ appId: e.appId, scopes })) {
      throw new Error(`invalid durable token authority for ${e.appId}`);
    }
    if (e.kind !== undefined && e.kind !== 'app' && e.kind !== 'device') {
      throw new Error(`unknown token kind for ${e.appId}`);
    }
    records.push({
      appId: e.appId,
      appName: e.appName,
      scopes,
      token: e.token,
      createdAt: e.createdAt,
      lastUsedAt: typeof e.lastUsedAt === 'number' ? e.lastUsedAt : 0,
      ...(e.kind === 'app' || e.kind === 'device' ? { kind: e.kind } : {}),
      ...(typeof e.deviceId === 'string' ? { deviceId: e.deviceId } : {}),
    });
  }
  return records;
}
