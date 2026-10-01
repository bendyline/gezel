/**
 * `prompt.executor-context-trim` — marker behavior that trims standing,
 * strategic-altitude context from an EXECUTOR-class gezel's system prompt
 * (developer / designer / builder / ...), keeping it intact for
 * ORCHESTRATOR roles (meester / voorman / planner). When this behavior is
 * on the resolved profile AND the session's role is an executor
 * (`!isPureDelegationRole(role)`), `buildInstructions` drops/condenses
 * three sections an executor cannot act on:
 *
 *   - shrinks the imported project-`about` budget (a smaller `budgetChars`
 *     to `scopeProjectAboutForTier` — local tiers only; the always-kept
 *     build/test/convention "essential" headings survive),
 *   - condenses the GitHub block to the checkout path (drops the PR/issue
 *     toolset prose, which names tools executors usually can't call),
 *   - drops the standing "Shared documents" library listing
 *     (`list_documents` stays callable; only the listing is removed).
 *
 * Rationale: most executor-irrelevant context (mission objectives, the
 * delegation guardrail, cross-task lists) is ALREADY gated away by role /
 * task-scope. This behavior trims the remaining marginal "org tax" that
 * dilutes a small model's attention away from its deliverable + tools. It
 * extends the same reasoning the mission-objectives gate already states
 * ("a Developer wiring up an API doesn't reason at that altitude" — see
 * [chat/manager.ts]).
 *
 * No hooks — the logic lives in `buildInstructions` ([chat/manager.ts]),
 * which AND-combines this flag with the executor-role check into a single
 * `trimExecutor` gate. Threaded via
 * `profileHasBehavior(profile, 'prompt.executor-context-trim')` at the one
 * call site in `ChatManager.buildSessionOpts`. OFF by default; flip it
 * per-run for A/B via the `GEZEL_FORCE_BEHAVIORS` env override
 * (`applyBehaviorEnvOverrides` in [model-profile/runtime.ts]). When OFF —
 * or for a non-executor role — the system prompt is byte-identical to
 * before.
 */

import type { Behavior } from '../types.js';

export const PromptExecutorContextTrim: Behavior = {
  id: 'prompt.executor-context-trim',
  description:
    'Trims standing/strategic context (shared-documents listing, GitHub PR prose) and shrinks the imported project-about budget for EXECUTOR-class roles (developer/designer/builder), which cannot act on org-altitude context. No hooks; gates sections in buildInstructions via a trimExecutor flag AND-combined with the executor-role check. OFF by default; A/B per-run via GEZEL_FORCE_BEHAVIORS.',
};
