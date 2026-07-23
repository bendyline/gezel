/**
 * `turn.single-tool-per-turn` — Meester-only opt-in that limits the
 * model to one tool call per user-initiated turn. The second
 * attempt this turn returns a teaching error explaining the rule
 * and asking the model to wait for the first result before
 * deciding the next action.
 *
 * The pattern this catches: Gemma 26B in Meester mode chains
 * `create_gezel_from_gilde` → `create_project` → `update_project`
 * → `message_gezel` in one streaming response without waiting for
 * any of them to return. The chain compounds fabrications because
 * each later call references results the model invented for the
 * earlier ones (the `mcp.validate-ids-strict` behavior catches
 * those individually, but only AFTER the chain has formed).
 *
 * Implementation: per-bridge `inFlight` counter incremented in
 * `preProcess` and drained in `onCallEnd` — the always-fires
 * terminal hook that runs even when the SDK transport throws
 * (`-32001: Request timed out`, child crash, framing error). This
 * is load-bearing: an earlier version drained from `postProcess`
 * + `postProcessError`, both of which the bridge skips on a
 * thrown call. A single timed-out tool wedged the rest of the
 * turn into perpetual "in-flight" rejections, which manifested as
 * the Gemma 26B voorman apology-spiral doom loop (see the
 * Choplifter Side-scroller debug bundle).
 *
 * Config:
 * - `meesterOnly: true` — only enforce on sessions where the
 *   acting gezel is the current Meester. Honored via
 *   `ctx.isMeester`. The single-tool rule is harsh and earns its
 *   keep on the Meester crew-recruitment flow where chained
 *   fabrications are the dominant failure mode; on voorman /
 *   worker sessions it punishes the legitimate "ensure gezel,
 *   add step, advance phase" sequence we explicitly want.
 * - `meesterOnly: false` — apply unconditionally. Useful for
 *   stress-test only, not a recommended default.
 */

import { z } from 'zod';
import { isGezelMcp } from '../../providers/mcp-wrappers/gezel-mcp-small-model.js';
import type {
  McpPreProcessVerdict,
  McpToolWrapper,
  McpToolWrapperContext,
} from '../../providers/mcp-wrappers/types.js';
import type { Behavior } from '../types.js';

const TurnSingleToolPerTurnConfigSchema = z.object({
  meesterOnly: z.boolean(),
});

export type TurnSingleToolPerTurnConfig = z.infer<typeof TurnSingleToolPerTurnConfigSchema>;

function buildSingleToolWrapper(config: TurnSingleToolPerTurnConfig): McpToolWrapper {
  let inFlight = 0;
  return {
    id: 'turn-single-tool-per-turn',
    matches: (spec) => isGezelMcp(spec),
    async preProcess(
      _toolName: string,
      _args: Record<string, unknown>,
      ctx: McpToolWrapperContext,
    ): Promise<McpPreProcessVerdict> {
      if (config.meesterOnly && !ctx.isMeester) {
        return { kind: 'allow' };
      }
      if (inFlight > 0) {
        return {
          kind: 'reject',
          error:
            'Wait — only one tool call per turn while the previous one is in flight. Read the result of the previous call first; the next call you make should be informed by what it returned, not what you assumed it would return.',
        };
      }
      inFlight += 1;
      return { kind: 'allow' };
    },
    async onCallEnd(
      _toolName: string,
      _args: Record<string, unknown>,
      ctx: McpToolWrapperContext,
    ): Promise<void> {
      if (config.meesterOnly && !ctx.isMeester) return;
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

export const TurnSingleToolPerTurn: Behavior<TurnSingleToolPerTurnConfig> = {
  id: 'turn.single-tool-per-turn',
  description:
    "Limits the model to one in-flight tool call per turn. Second concurrent attempt is rejected with a teaching error. Meester-only opt-in — too aggressive for general flows. Defends Gemma 4 26B's chained-fabrication cascade in Meester sessions.",
  configSchema: TurnSingleToolPerTurnConfigSchema,
  defaultConfig: { meesterOnly: true },
  mcpWrapper: (config) => buildSingleToolWrapper(config),
};
