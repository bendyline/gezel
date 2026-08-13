/**
 * Bring-your-own OAuth app: pure helpers behind the connector bind flow's
 * setup panel. Gezel is open source and ships no OAuth client of its own —
 * each install registers its own developer app per provider (client ID in
 * `config.oauthClients` via `/api/oauth-clients`, secret in the SecretStore).
 * A connector-type manifest names the pair via `secretShape.clientIdEnv` /
 * `clientSecretEnv` and may carry a `clientSetup` block with the copy that
 * turns the panel from a bare form into instructions.
 */

/** Mirrors the oauth-clients route's key rule — a manifest that fails it gets no panel. */
const CLIENT_KEY = /^GEZEL_[A-Z0-9_]{1,120}$/;

export interface OAuthAppRequirement {
  /** `config.oauthClients` / SecretStore key — the manifest's `clientIdEnv` name. */
  clientKey: string;
  /** Whether the manifest declares a client-secret env slot at all. */
  hasSecretField: boolean;
  /** Secret must be provided; false = optional (PKCE public clients). */
  secretRequired: boolean;
  providerLabel: string;
  docsUrl?: string;
  appTypeNote?: string;
  /**
   * Fixed loopback port for providers that match redirect URIs exactly
   * (X, Meta). Absent = any ephemeral 127.0.0.1 port works (RFC 8252 —
   * Google, Microsoft).
   */
  redirectPort?: number;
  redirectNote?: string;
  /**
   * Ordered, provider-specific registration walkthrough ("create the app,
   * add the product, where the ID lives"). Rendered as a numbered list;
   * capped so a runaway manifest can't turn the panel into a wall.
   */
  steps?: string[];
}

const MAX_SETUP_STEPS = 8;

/**
 * Read an oauth2 `secretShape` (untyped manifest JSON) into the panel's
 * requirement, with sane fallbacks when `clientSetup` is absent: the type
 * name stands in for the provider label and the guidance stays generic.
 * Returns null for non-OAuth shapes and manifests whose `clientIdEnv`
 * would be rejected by the oauth-clients route anyway.
 */
export function parseOAuthAppRequirement(
  typeName: string,
  secretShape: unknown,
): OAuthAppRequirement | null {
  if (!secretShape || typeof secretShape !== 'object') return null;
  const shape = secretShape as Record<string, unknown>;
  if (shape.kind !== 'oauth2') return null;
  const clientKey = typeof shape.clientIdEnv === 'string' ? shape.clientIdEnv : '';
  if (!CLIENT_KEY.test(clientKey)) return null;
  const hasSecretField =
    typeof shape.clientSecretEnv === 'string' && shape.clientSecretEnv.length > 0;
  const setup = (
    shape.clientSetup && typeof shape.clientSetup === 'object' ? shape.clientSetup : {}
  ) as Record<string, unknown>;
  const providerLabel =
    typeof setup.providerLabel === 'string' && setup.providerLabel.trim()
      ? setup.providerLabel.trim()
      : typeName;
  const docsUrl =
    typeof setup.docsUrl === 'string' && /^https:\/\//.test(setup.docsUrl)
      ? setup.docsUrl
      : undefined;
  const redirectPort =
    typeof setup.redirectPort === 'number' &&
    Number.isInteger(setup.redirectPort) &&
    setup.redirectPort >= 1024 &&
    setup.redirectPort <= 65535
      ? setup.redirectPort
      : undefined;
  const appTypeNote =
    typeof setup.appTypeNote === 'string' && setup.appTypeNote.trim()
      ? setup.appTypeNote.trim()
      : undefined;
  const redirectNote =
    typeof setup.redirectNote === 'string' && setup.redirectNote.trim()
      ? setup.redirectNote.trim()
      : undefined;
  const steps = Array.isArray(setup.steps)
    ? setup.steps
        .filter((step): step is string => typeof step === 'string' && step.trim().length > 0)
        .map((step) => step.trim())
        .slice(0, MAX_SETUP_STEPS)
    : [];
  return {
    clientKey,
    hasSecretField,
    secretRequired: hasSecretField && setup.secretRequired === true,
    providerLabel,
    ...(docsUrl ? { docsUrl } : {}),
    ...(appTypeNote ? { appTypeNote } : {}),
    ...(redirectPort !== undefined ? { redirectPort } : {}),
    ...(redirectNote ? { redirectNote } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  };
}

/**
 * The exact URI the user registers on the provider when the manifest pins a
 * port. Must match the shell listener character-for-character: `127.0.0.1`
 * (not `localhost` — X's validator is happier with the literal address) and
 * the `/callback` path from `mail:oauth-listen`.
 */
export function fixedRedirectUri(redirectPort: number): string {
  return `http://127.0.0.1:${redirectPort}/callback`;
}

/**
 * Recognize the service's "OAuth is not configured for this connector — …"
 * rejection from `resolveOAuthClient`, which is the cue to open the setup
 * panel instead of leaving the user with a bare error line.
 */
export function isOAuthNotConfiguredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /oauth is not configured/i.test(message);
}
