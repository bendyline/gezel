/**
 * `tools.gezels-as-roles` — marker behavior that opts a model in to
 * role-typed delegation tools. When this behavior is on the resolved
 * profile, the session's tool allowlist gains a curated set of
 * `delegate_<role>` / `consult_<role>` tools (developer, designer,
 * reviewer, planner, ...) and the generic `ask_specialist` / `ask_gezel`
 * dispatchers are demoted, so the delegation TARGET lives in the tool
 * identity instead of a free-text argument.
 *
 * Rationale: small/medium local models select a well-named tool far more
 * reliably than they fill a polymorphic `gezel`/`role` argument — the
 * same principle as the cookbook discovery nudge. The 20 role tools
 * (10 roles × {delegate, consult}) are registered statically in the MCP
 * server ([packages/mcp/src/server.ts]); this behavior only controls
 * which of them the model SEES + can call, via the allowlist.
 *
 * No hooks — the logic lives in `computeToolAllowlist`
 * ([chat/role-tool-filter.ts]) which reads `rolesAsTools` (threaded from
 * `profileHasBehavior(profile, 'tools.gezels-as-roles')` at the single
 * call site in `ChatManager.buildSessionOpts`). OFF by default; flip it
 * per-run for A/B via the `GEZEL_FORCE_BEHAVIORS` env override
 * (`applyBehaviorEnvOverrides` in [model-profile/runtime.ts]).
 */

import type { Behavior } from '../types.js';

export const ToolsGezelsAsRoles: Behavior = {
  id: 'tools.gezels-as-roles',
  description:
    'Opts a model in to role-typed delegation tools (delegate_<role> / consult_<role>) in place of the generic ask_specialist / ask_gezel dispatchers, so the delegation target lives in the tool identity. Curated per orchestrator role via the allowlist; OFF by default. Aimed at small/medium local models that route more reliably by tool selection than by free-text argument.',
};
