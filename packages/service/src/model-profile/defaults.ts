/**
 * Tier-keyed default behavior sets for catalog models that don't
 * declare their own `behaviors` array (third-party imports, old
 * generated manifests, mock test catalogs). Mirrors the tier-driven
 * defaults the codebase used before the registry existed: tiny gets
 * the full cookbook + schema relaxation; small gets the condensed
 * rules; the rest get nothing extra.
 *
 * Cloud providers always get an empty behavior set — frontier models
 * don't need the local-model coddling.
 *
 * The data here is just the raw entry shapes (`string |
 * { id, config }`); the registry materializes them through the same
 * `validateConfig` pipeline that handles manifest-declared entries,
 * so the validation rules stay in one place.
 */

import type { BehaviorEntry, ModelStyle, ProviderName } from '@bendyline/gezel';
import { isLocalProvider } from '@bendyline/gezel';
import type { ModelTier } from '../chat/local-model-tier.js';

/**
 * Tier-default behavior entries. The fabrication detector lives on
 * every local tier — the failure mode it catches ("I've kicked off
 * the project" with no tool call) does not disappear at 25B or 70B;
 * a Meester running on gemma4-26b (medium) fabricates the same shape
 * as one on mistral-7b (small). Only `cloud` opts out — frontier
 * models don't need the heuristic and the false-positive surface is
 * easier to flag at that scale.
 */
export const TIER_DEFAULT_BEHAVIORS: Record<ModelTier, ReadonlyArray<BehaviorEntry>> = {
  tiny: [
    'prompt.tool-cookbook-full',
    'mcp.relax-required-fields',
    'mcp.default-missing-fields',
    // Manifest-less local imports otherwise pay the full ~23K-token raw
    // MCP tool-schema prose on every first turn — the single largest
    // first-prompt cost, and it starves the tier that can least afford
    // attention. The behavior self-gates to skip `cloud` only; every
    // local tier that selects it is compacted.
    'mcp.compact-tool-schemas',
    'fabrication.detect-past-tense-no-tools',
    { id: 'turn.continuation-budget', config: { count: 4 } },
    'prompt.retrieval-first',
  ],
  small: [
    'prompt.tool-cookbook-condensed',
    'mcp.compact-tool-schemas',
    'fabrication.detect-past-tense-no-tools',
    'prompt.retrieval-first',
  ],
  // The gestalt block pays where attention budget allows and repo
  // orientation is the bottleneck; retrieval-first steers the tiers most
  // prone to read_file-walking. compact-tool-schemas keeps the schema
  // tax off medium locals too. Note it does NOT stop at `large` — only
  // `cloud` is exempt — so a fast large local still trades tool prose
  // for prefill; A/B that per model with GEZEL_REMOVE_BEHAVIORS rather
  // than assuming the trade holds at every size. Cloud stays empty.
  medium: [
    'mcp.compact-tool-schemas',
    'fabrication.detect-past-tense-no-tools',
    'prompt.retrieval-first',
    'prompt.workspace-gestalt',
    'prompt.documents-summaries',
  ],
  large: [
    'fabrication.detect-past-tense-no-tools',
    'prompt.workspace-gestalt',
    'prompt.documents-summaries',
  ],
  cloud: [],
};

/**
 * Default style for an unknown model — picked from the provider
 * alone. Cloud providers run frontier-style strict surfaces (no
 * chain-of-thought leakage to handle); locals default to the
 * think-style extractor because that is the most common leaked
 * reasoning shape across Qwen / DeepSeek / Mistral / etc.
 *
 * Only consulted when the manifest doesn't declare a `style` field.
 * Any explicit style on a manifest wins.
 */
export function defaultStyleForProvider(providerName: ProviderName): ModelStyle {
  if (!isLocalProvider(providerName)) {
    return { family: 'other', reasoningFormat: 'none', toolCallFormat: 'function-call' };
  }
  return { family: 'other', reasoningFormat: 'think', toolCallFormat: 'function-call' };
}
