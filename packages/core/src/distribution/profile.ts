/**
 * How this build was distributed, and what that permits at runtime.
 *
 * A deliberate **sibling** of {@link resolveSecurityPolicy}, not a capability
 * inside it. The security policy gates *model agency* and explicitly exempts
 * user-initiated actions — a human installing a toolset or downloading an
 * engine is always allowed there. A store build must refuse those same
 * actions no matter who initiates them, because App Store guideline 2.4.5(iv)
 * and the Microsoft Store equivalent forbid downloading or installing
 * executable code outside the reviewed package. Two opposite axes; folding
 * one into the other would make each unreadable.
 *
 * Enforcement seams resolve the policy and read the derived predicates —
 * never the raw `profile` label, which exists for UI and telemetry only.
 *
 * What is NOT gated here: data. Model weights, `.gezk` knowledge catalogs,
 * and gilde content are downloadable in every profile — the store rules are
 * about executable code.
 */

/**
 * `store` covers both the Mac App Store and Microsoft Store builds. The
 * download bans are identical on the two platforms; what differs between
 * them (running binaries in place from the app bundle, a frozen Python
 * runtime) keys on platform and on the paths the supervisor stamps, not on
 * a second profile value.
 */
export type DistributionProfile = 'standard' | 'store';

/** Features a build can refuse, each with its own user-facing explanation. */
export type RestrictedFeature =
  | 'playwright'
  | 'copilot-install'
  | 'engine-download'
  | 'python'
  | 'npm';

export interface ResolvedDistributionPolicy {
  /** Echoed for UI/telemetry; never read by enforcement. */
  profile: DistributionProfile;
  /**
   * Whether system toolsets may be fetched and installed at runtime — the
   * eager Playwright/Chromium bootstrap and the on-demand Copilot SDK.
   */
  allowRuntimeCodeDownloads: boolean;
  /**
   * Whether engine binaries may be fetched from a release. Bundled engines
   * resolve in every profile; this gates only the download fallback.
   */
  allowEngineBinaryDownloads: boolean;
  /**
   * `frozen-only` means a Python environment may be *resolved* from one
   * pre-baked into the build, never created and never installed into.
   */
  pythonProvisioning: 'full' | 'frozen-only';
  /** Whether workspace scripts may install packages from a registry. */
  allowNpmInstalls: boolean;
  /**
   * Whether the unauthenticated Ollama-emulation listener may bind. The
   * authenticated `/v1` Connected Apps surface is unaffected.
   */
  allowOllamaEmulation: boolean;
  /** The one place refusal copy is written, for every surface that shows it. */
  refusalReason(feature: RestrictedFeature): string;
}

const STORE_REFUSALS: Record<RestrictedFeature, string> = {
  playwright:
    'Browser automation tools are not included in this build. Install Gezel from gezel.com to add them.',
  'copilot-install':
    'This build cannot install the GitHub Copilot SDK. Install the Copilot CLI yourself and Gezel will use it, or install Gezel from gezel.com.',
  'engine-download':
    'This build runs only the engines it ships with. Install Gezel from gezel.com to download additional engines.',
  python:
    'This build does not include the Python runtime that model needs. Choose an on-device model that runs on the built-in engine, or install Gezel from gezel.com.',
  npm: 'This build cannot install packages. Write dependency-free code using Node built-ins instead.',
};

function standardRefusal(feature: RestrictedFeature): string {
  // Reachable only if a caller asks a `standard` policy for refusal copy,
  // which means the caller checked the wrong predicate. Say something true
  // rather than implying a restriction that does not exist.
  return `${feature} is available in this build.`;
}

/**
 * Resolve the distribution policy from the environment.
 *
 * Only the exact string `store` restricts anything: an unset, misspelled, or
 * partially-written value resolves to `standard` rather than to a
 * half-configured store build. The store builds themselves do not rely on
 * this default — they stamp the variable from a build marker and overwrite
 * whatever they inherited, so the env var can never *loosen* a store build.
 */
export function resolveDistributionProfile(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDistributionPolicy {
  const profile: DistributionProfile =
    env.GEZEL_DISTRIBUTION_PROFILE === 'store' ? 'store' : 'standard';
  const store = profile === 'store';
  return {
    profile,
    allowRuntimeCodeDownloads: !store,
    allowEngineBinaryDownloads: !store,
    pythonProvisioning: store ? 'frozen-only' : 'full',
    allowNpmInstalls: !store,
    allowOllamaEmulation: !store,
    refusalReason: store ? (feature) => STORE_REFUSALS[feature] : standardRefusal,
  };
}
