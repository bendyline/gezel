import { z } from 'zod';
import { ScriptRefSchema } from './script.js';

/**
 * ─ Hooks ────────────────────────────────────────────────────────────
 *
 * A hook gates MCP tool calls at the bridge layer. The MCP bridge
 * consults the active hooks list before forwarding a `tools/call` and
 * after a successful response, running the matching script and
 * honoring its `{ decision: 'allow' | 'deny' | 'ask', message? }`
 * return.
 *
 * Hooks are declared on a craftbook (via the optional `hooks?: HookSpec[]`
 * field) and activated when the craftbook becomes the *active* craftbook
 * on a chat session. Multiple craftbooks can be active at once (catalog +
 * workspace-discovered overlay); their hook lists are concatenated in
 * registration order. First deny wins; `ask` surfaces via the existing
 * `ask_user_question` UX before allowing the call.
 *
 * The hook script receives the tool name + args via its declared `inputs`
 * and must return either:
 *   - `{ decision: 'allow' }` — call proceeds unchanged
 *   - `{ decision: 'deny', message?: string }` — call is rejected with
 *     the message surfaced to the model
 *   - `{ decision: 'ask', message: string }` — UI prompts the user; on
 *     approval the call proceeds, on cancel it's denied
 *
 * Modeled on Claude Code's `hooks.PreToolUse[]` / `hooks.PostToolUse[]`
 * frontmatter shape so gstack-style skills port cleanly.
 */

export const HookPhaseSchema = z.enum(['PreToolUse', 'PostToolUse']);
export type HookPhase = z.infer<typeof HookPhaseSchema>;

export const HookDecisionSchema = z.enum(['allow', 'deny', 'ask']);
export type HookDecision = z.infer<typeof HookDecisionSchema>;

/**
 * Single hook entry. `matcher` is a JavaScript regex string compiled
 * against the tool name (empty string or `.*` matches everything).
 *
 * A hook resolves its decision one of two ways, exactly one of which must
 * be set:
 *   - `script` — a project-scoped gezel script that returns the decision
 *     dynamically (inspecting the tool name + args).
 *   - `decision` — a static verdict, no script run. The synthesized
 *     auto-allow hooks a craftbook's `toolsets[].autoAllow` produces use
 *     `{ decision: 'allow' }` so pre-authorization needs no authored
 *     script. (A static `'ask'` is accepted but degrades like any other
 *     ask on providers where the ask UX isn't wired.)
 */
export const HookSpecSchema = z
  .object({
    phase: HookPhaseSchema,
    matcher: z.string().default('.*'),
    script: ScriptRefSchema.optional(),
    /** Static verdict — mutually exclusive with `script`. */
    decision: HookDecisionSchema.optional(),
    /**
     * Optional human-readable label shown in the UI when this hook
     * blocks/asks. Useful when one craftbook installs multiple hooks
     * against the same matcher.
     */
    label: z.string().optional(),
  })
  .superRefine((spec, ctx) => {
    const hasScript = spec.script !== undefined;
    const hasDecision = spec.decision !== undefined;
    if (hasScript === hasDecision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a hook must set exactly one of `script` or `decision`',
        path: [hasScript ? 'decision' : 'script'],
      });
    }
  });
export type HookSpec = z.infer<typeof HookSpecSchema>;

/**
 * Result returned by a hook script. The script's declared `outputs`
 * should match this shape; the bridge coerces loosely (missing
 * `decision` is treated as `allow` so a buggy script doesn't lock the
 * model out of every tool).
 */
export const HookResultSchema = z.object({
  decision: HookDecisionSchema.default('allow'),
  message: z.string().optional(),
});
export type HookResult = z.infer<typeof HookResultSchema>;
