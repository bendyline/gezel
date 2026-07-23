import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { ProviderCredentialName, SecretKey, SecretStore } from './types.js';

/** All known provider-credential names we enumerate at screen time. */
const ALL_PROVIDER_CREDENTIAL_NAMES: ProviderCredentialName[] = [
  'githubToken',
  'openaiApiKey',
  'openaiOrganization',
  'anthropicApiKey',
  'webhookBearerToken',
  'webhookBasicAuth',
  'braveSearchApiKey',
  'tavilyApiKey',
];

/**
 * Gather every currently-stored provider-credential value in the
 * workspace. Used by the outbound URL screen on `fetch_url` to reject
 * requests that contain a credential substring, regardless of which
 * project issued them — credentials are global, attack surface is
 * global. Returns empty strings filtered out; callers receive only
 * real, non-empty secret values.
 */
export async function collectProviderSecretValues(secrets: SecretStore): Promise<string[]> {
  const out: string[] = [];
  for (const name of ALL_PROVIDER_CREDENTIAL_NAMES) {
    const v = await secrets.get({ kind: 'providerCredential', name });
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
}

/**
 * Short-name → SecretKey registry. Scripts and MCP tools declare the
 * credentials they want to use by short name (e.g. `github.token`);
 * the registry resolves the name to the underlying `SecretKey` and
 * fetches the value from `SecretStore` — but only after checking
 * that the current project has explicitly granted access.
 *
 * Naming convention:
 *   - Provider credentials: `github.token`, `openai.key`,
 *     `openai.organization`, `webhook.bearer`, `webhook.basic`
 *   - Toolset secrets: `<toolsetId>.<fieldId>` (dot-joined)
 *
 * The name space is flat — credentials are globally stored, so two
 * projects can reach the same underlying secret, provided each has
 * granted the name.
 */

export class CredentialDeniedError extends Error {
  readonly code = 'CREDENTIAL_DENIED';
  constructor(
    readonly credentialName: string,
    readonly projectId: string,
  ) {
    super(
      `project "${projectId}" has not been granted credential "${credentialName}". Grant it via the project's settings before scripts/tools here can resolve it.`,
    );
    this.name = 'CredentialDeniedError';
  }
}

export class CredentialMissingError extends Error {
  readonly code = 'CREDENTIAL_MISSING';
  constructor(readonly credentialName: string) {
    super(
      `no value stored for credential "${credentialName}". Add it in Settings (or install the toolset that provides it) first.`,
    );
    this.name = 'CredentialMissingError';
  }
}

/**
 * Context that travels with a `resolve()` call so the audit log can
 * record *who* asked. Shape is permissive on purpose — script runs
 * pass `{ kind: 'script', scriptName, runId }`; MCP tool paths would
 * pass `{ kind: 'tool', toolName, sessionId }`. Omitting the context
 * skips the audit log; the resolution still happens.
 */
export type CredentialUseContext =
  | { kind: 'script'; scriptName: string; runId: string; gezelId?: string }
  | { kind: 'tool'; toolName: string; sessionId: string; gezelId?: string }
  | { kind: 'manual'; note?: string };

export interface CredentialRegistry {
  /**
   * Resolve the value of a named credential for a given project.
   * Throws `CredentialDeniedError` if the project hasn't granted the
   * name, `CredentialMissingError` if no value is stored. Returns the
   * raw secret value on success — callers must treat this as secret
   * and scrub from any output that reaches the model or the disk.
   *
   * Pass `useContext` to emit a `credential.used` history event with
   * the calling script/tool's identity. Successful resolutions are
   * the only thing recorded — denial and missing-value throws are
   * noise that would dominate the log in misconfigured states.
   */
  resolve(
    credentialName: string,
    projectId: string,
    useContext?: CredentialUseContext,
  ): Promise<string>;

  /**
   * List all credentials a project has been granted (doesn't fetch
   * values — just the names). Used by the Settings UI.
   */
  listGrants(projectId: string): Promise<string[]>;
}

/**
 * Simple name → SecretKey mapping for the "built-in" provider
 * credentials. Toolset credentials resolve by pattern
 * (`<toolsetId>.<fieldId>` → `{kind: 'toolset', toolsetId, fieldId}`)
 * so the map doesn't need to enumerate every toolset at boot.
 */
const PROVIDER_CREDENTIAL_NAMES: Record<string, ProviderCredentialName> = {
  'github.token': 'githubToken',
  'openai.key': 'openaiApiKey',
  'openai.organization': 'openaiOrganization',
  'anthropic.key': 'anthropicApiKey',
  'webhook.bearer': 'webhookBearerToken',
  'webhook.basic': 'webhookBasicAuth',
  'brave.key': 'braveSearchApiKey',
  'tavily.key': 'tavilyApiKey',
};

/**
 * Translate a short credential name to its `SecretKey`. Returns null
 * when the name is malformed (doesn't match either the provider
 * registry or the `<toolsetId>.<fieldId>` pattern). Callers should
 * treat null as "unknown credential" — distinct from "known name,
 * not granted" (denied) and "known + granted, but no value stored"
 * (missing).
 */
export function secretKeyForCredential(name: string): SecretKey | null {
  const provider = PROVIDER_CREDENTIAL_NAMES[name];
  if (provider) return { kind: 'providerCredential', name: provider };
  const dot = name.indexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return {
    kind: 'toolset',
    toolsetId: name.slice(0, dot),
    fieldId: name.slice(dot + 1),
  };
}

export class DefaultCredentialRegistry implements CredentialRegistry {
  constructor(
    private readonly store: Store,
    private readonly secrets: SecretStore,
    private readonly history?: HistoryManager,
  ) {}

  async resolve(
    credentialName: string,
    projectId: string,
    useContext?: CredentialUseContext,
  ): Promise<string> {
    const project = await this.store.getProject(projectId);
    const granted = project?.grantedCredentials ?? [];
    if (!granted.includes(credentialName)) {
      throw new CredentialDeniedError(credentialName, projectId);
    }
    const key = secretKeyForCredential(credentialName);
    if (!key) throw new CredentialMissingError(credentialName);
    const value = await this.secrets.get(key);
    if (value == null || value.length === 0) {
      throw new CredentialMissingError(credentialName);
    }

    if (this.history && useContext) {
      await this.logUse(credentialName, projectId, useContext).catch(() => {
        /* audit failure must not block credentialed work */
      });
    }
    return value;
  }

  async listGrants(projectId: string): Promise<string[]> {
    const project = await this.store.getProject(projectId);
    return project?.grantedCredentials ?? [];
  }

  private async logUse(
    credentialName: string,
    projectId: string,
    ctx: CredentialUseContext,
  ): Promise<void> {
    if (!this.history) return;
    const summary =
      ctx.kind === 'script'
        ? `Credential "${credentialName}" used by script ${ctx.scriptName} (run ${ctx.runId})`
        : ctx.kind === 'tool'
          ? `Credential "${credentialName}" used by tool ${ctx.toolName} (session ${ctx.sessionId})`
          : `Credential "${credentialName}" resolved manually${ctx.note ? ` — ${ctx.note}` : ''}`;
    await this.history.log({
      kind: 'credential.used',
      projectId,
      ...(ctx.kind !== 'manual' && ctx.gezelId ? { gezelId: ctx.gezelId } : {}),
      summary,
      details: { credentialName, context: ctx },
    });
  }
}
