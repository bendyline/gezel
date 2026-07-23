import type { GezelConfig, SecurityPolicy } from '../schemas/api.js';
import type { Project } from '../schemas/project.js';

/**
 * Centralized security & compliance resolution.
 *
 * One config object (`config.securityPolicy`) is the single source of
 * truth; every enforcement seam in the app resolves it through
 * {@link resolveSecurityPolicy} and reads the effective capability set —
 * never the raw level. The `level` is purely a UI label.
 *
 * The capability axis that actually matters is **agency**: these flags
 * gate what the *model* may do autonomously. User-initiated actions (a
 * human pulling a GitHub repo, downloading a HuggingFace model, the app
 * running its own npm/node/CLI/MCP processes) are deliberately exempt.
 */

export type SecurityLevel = SecurityPolicy['level'];

/** A preset level (everything except the synthetic `custom`). */
export type SecurityPresetLevel = Exclude<SecurityLevel, 'custom'>;

/** The five authoritative capability booleans (no `level`). */
export type SecurityCapabilities = Omit<SecurityPolicy, 'level'>;

/**
 * Copilot's SDK-native tools run outside Gezel's scoped MCP bridge. Keep
 * those built-ins denied unless the user explicitly opts out, so an absent
 * setting cannot bypass project scope, security-policy sinks, or auditing.
 */
export const DEFAULT_SANDBOX_COPILOT = true;

/**
 * Resolve the install-level Copilot sandbox setting plus an optional
 * per-gezel override. Explicit `false` remains the deliberate escape hatch;
 * missing values fail closed to the sandboxed MCP surface.
 */
export function resolveSandboxCopilot(
  installSetting: boolean | undefined,
  gezelOverride?: boolean,
): boolean {
  return gezelOverride ?? installSetting ?? DEFAULT_SANDBOX_COPILOT;
}

/**
 * The resolved posture: the five stored capabilities plus the derived
 * predicates the enforcement points consume directly.
 */
export interface ResolvedSecurityPolicy extends SecurityCapabilities {
  /** Echoed for UI/telemetry; never read by enforcement. */
  level: SecurityLevel;
  /**
   * Whether non-builtin (third-party) MCP toolsets may load. They bypass
   * the builtin tool allowlist and can't be confined yet, so a declared
   * "local-only" scope isn't trustworthy — allowed at `free` only.
   */
  allowNonBuiltinToolsets: boolean;
  /**
   * Whether the model's git/github tools (`run_git`, `github_*`) surface.
   * Rides on file edits: git push / PR creation are mutations, and the
   * `lockdown` preset (which enables edits) is exactly where GitHub R/W is
   * intended to work, while `super-lockdown` (edits off) keeps the model
   * out of git entirely. User-initiated GitHub R/O is unaffected — that
   * path never goes through these tools.
   */
  allowModelGit: boolean;
  /**
   * Whether email sync + send may run. Both reach an external mail provider
   * over the network, so they ride on `allowExternalServices` — present only
   * at `free` among the presets. Under `lockdown`/`super-lockdown` the mail
   * subsystem stays dormant: no background sync, and the send tool is not even
   * exposed to the model (the strongest form of injection containment — the
   * capability simply isn't there). User-initiated linking of a mailbox is a
   * separate, deliberate action and is not gated here.
   */
  allowMail: boolean;
}

/**
 * Preset → capability mapping. Keep in lockstep with the table in the
 * Security & Compliance plan / panel copy.
 *
 * - `super-lockdown`: nothing leaves the machine. Local models only, no
 *   services, no scripts, no auto-update, no model git, and no
 *   shared-document writes from scripts. Read/review/index and the builtin
 *   artifact/document tools still work.
 *   Workspace file writes are NOT globally gated by this level — they are
 *   governed per project by {@link projectWorkspaceWritable}: internal
 *   workspaces (our own folder, nothing precious) stay writable, external
 *   working directories stay deny-until-opted-in.
 * - `lockdown`: coding posture. Edits, scripts, cloud chat, GitHub R/W,
 *   auto-update — but no open-web research (services off).
 * - `free`: everything.
 */
export const SECURITY_PRESETS: Record<SecurityPresetLevel, SecurityCapabilities> = {
  'super-lockdown': {
    allowFileEdits: false,
    allowExternalChat: false,
    allowExternalServices: false,
    allowScriptExecution: false,
    allowAppNetwork: false,
  },
  lockdown: {
    allowFileEdits: true,
    allowExternalChat: true,
    allowExternalServices: false,
    allowScriptExecution: true,
    allowAppNetwork: true,
  },
  free: {
    allowFileEdits: true,
    allowExternalChat: true,
    allowExternalServices: true,
    allowScriptExecution: true,
    allowAppNetwork: true,
  },
};

/**
 * Fail-safe posture for a config with no stored policy. First-run migration
 * explicitly writes `free` for legacy installs, preserving compatibility
 * without making absence permanently mean "unrestricted".
 */
export const DEFAULT_SECURITY_LEVEL: SecurityPresetLevel = 'lockdown';

/**
 * Build a full {@link SecurityPolicy} object for a preset level — used by
 * the slider (and the first-run step) to write the five booleans in
 * lockstep with the chosen level.
 */
export function securityPolicyForLevel(level: SecurityPresetLevel): SecurityPolicy {
  return { level, ...SECURITY_PRESETS[level] };
}

/**
 * Given a set of capability booleans, return the preset level they match,
 * or `'custom'` if they don't match any preset. Lets the UI re-label the
 * slider to "Custom" the moment a toggle is flipped off-preset.
 */
export function classifySecurityLevel(caps: SecurityCapabilities): SecurityLevel {
  for (const level of ['super-lockdown', 'lockdown', 'free'] as const) {
    const preset = SECURITY_PRESETS[level];
    if (
      preset.allowFileEdits === caps.allowFileEdits &&
      preset.allowExternalChat === caps.allowExternalChat &&
      preset.allowExternalServices === caps.allowExternalServices &&
      preset.allowScriptExecution === caps.allowScriptExecution &&
      preset.allowAppNetwork === caps.allowAppNetwork
    ) {
      return level;
    }
  }
  return 'custom';
}

/**
 * Effective per-project workspace writability for gezel-initiated work —
 * THE single gate for workspace file writes (tool surface, script
 * `workspace.write` capability, Store mutations, ambient scheduler work).
 *
 * Semantics of `project.allowGezelWrites` (an optional boolean, so
 * effectively a tri-state):
 *
 *   - explicit `true`  → writable, including external working dirs the
 *     user has consented to (the confirmation-dialog path);
 *   - explicit `false` → read-only for gezels, including internal
 *     workspaces (the per-project "edits off" switch);
 *   - unset            → internal workspaces are writable (our folder
 *     under `~/.gezel/projects/<id>/workspace/`, no precious files),
 *     external `workingDir`s are not (the user's real folder — writes
 *     require the explicit opt-in above).
 *
 * The global security policy's `allowFileEdits` deliberately does NOT
 * factor in: a fresh internal project (a checkers board, a scratch
 * notebook) stays functional under super-lockdown, while folder-backed
 * projects keep their deny-by-default consent gate at every security
 * level. `undefined`/`null` project means the implicit default bucket —
 * internal, writable.
 */
export function projectWorkspaceWritable(
  project?: Pick<Project, 'workingDir' | 'allowGezelWrites'> | null,
): boolean {
  if (!project) return true;
  if (project.allowGezelWrites !== undefined) return project.allowGezelWrites;
  return !project.workingDir;
}

/**
 * Resolve the effective security posture from config. The five stored
 * booleans are always authoritative (the `level` is just a label); when
 * the policy is absent we fall back to {@link DEFAULT_SECURITY_LEVEL}.
 */
export function resolveSecurityPolicy(
  config: Pick<GezelConfig, 'securityPolicy'>,
): ResolvedSecurityPolicy {
  const stored = config.securityPolicy;
  const caps: SecurityCapabilities = stored
    ? {
        allowFileEdits: stored.allowFileEdits,
        allowExternalChat: stored.allowExternalChat,
        allowExternalServices: stored.allowExternalServices,
        allowScriptExecution: stored.allowScriptExecution,
        allowAppNetwork: stored.allowAppNetwork,
      }
    : SECURITY_PRESETS[DEFAULT_SECURITY_LEVEL];
  const level = stored?.level ?? DEFAULT_SECURITY_LEVEL;
  return {
    level,
    ...caps,
    // Third-party MCP toolsets are unconfined code + network, and can't be
    // sandboxed yet. Require both of the riskiest capabilities — true only
    // at `free` among the presets, and an explicit opt-in under `custom`.
    allowNonBuiltinToolsets: caps.allowExternalServices && caps.allowScriptExecution,
    // Model git/github tools ride on file edits (see field doc above).
    allowModelGit: caps.allowFileEdits,
    // Email sync + send are external-service network actions (see field doc).
    allowMail: caps.allowExternalServices,
  };
}
