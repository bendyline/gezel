import type { ScorecardDevice } from './schema.js';

/**
 * ─ Scorecard filtering vocabulary ────────────────────────────────────
 *
 * The published scorecard is a stack of test rounds, and a reader almost
 * never wants all of them: they want one machine, one model's history, or
 * the round from a particular day. That means two surfaces have to agree on
 * a vocabulary — the renderer that stamps each round and row with what it
 * is, and the browser script that reads those stamps back and narrows the
 * page from a URL.
 *
 * They agree here. Both the attribute names and the query-parameter names
 * live in this module and are interpolated into the emitted markup and into
 * the script, so a rename cannot leave one side reading a stamp the other
 * side stopped writing — the drift that would show up as a filter that
 * silently matches nothing.
 */

/**
 * Query parameters a published scorecard page understands. `round` is
 * canonical (a run id is unique); `date` is the shareable alias a person
 * would actually type, and resolves to every round started that day —
 * dates are NOT unique, two machines have been swept on one date before.
 */
export const SCORECARD_QUERY_PARAMS = {
  round: 'round',
  date: 'date',
  hardware: 'hardware',
  model: 'model',
  modelClass: 'class',
} as const;

/** Reserved `round` values, distinct from any run id. */
export const SCORECARD_ROUND_LATEST = 'latest';
export const SCORECARD_ROUND_ALL = 'all';

/** `data-` attributes the renderer stamps and the browser script reads. */
export const SCORECARD_DATA_ATTRS = {
  /** Marks the whole widget, and carries nothing else. */
  root: 'data-hb-scorecard',
  /** Empty element the script replaces with the control bar. */
  controls: 'data-hb-scorecard-controls',
  /** One test round: a provenance stamp plus its suite tables. */
  round: 'data-hb-round',
  roundLabel: 'data-hb-round-label',
  date: 'data-hb-date',
  hardware: 'data-hb-hardware',
  hardwareLabel: 'data-hb-hardware-label',
  /** Space-separated model families the round measured. */
  models: 'data-hb-models',
  /** Space-separated capability tiers the round measured. */
  tiers: 'data-hb-tiers',
  /** Present only on the newest round — the default view. */
  latest: 'data-hb-latest',
  /** One suite's heading + table, so an emptied suite hides as a unit. */
  suite: 'data-hb-suite',
  /** A result row, stamped with the model family and its capability tier. */
  model: 'data-hb-model',
  tier: 'data-hb-tier',
} as const;

/**
 * Quantization suffixes, stripped so a reader can ask for a model rather
 * than for one of its quantizations. `qwen3.8-27b-q4`, `-q8`, and
 * `-iq1-s` are three measurements of `qwen3.8-27b`, and someone following
 * a link to "how does this model do" wants all of them.
 *
 * The trailing size code is an allowlist rather than `[a-z]+` on purpose:
 * a bare `-(\w+)` tail would swallow a real name segment, turning
 * `something-q4-instruct` into `something` and quietly merging two
 * different models into one row group.
 */
const QUANT_SUFFIX_RE =
  /-(?:i?q\d+(?:_[a-z0-9]+)*(?:-(?:xxxs|xxs|xs|s|m|l|xl))?|bf16|fp16|fp8|f16|f32|mxfp4|int4|int8|\d+bit)$/i;

/**
 * The model id with its quantization dropped — the identity the model
 * dropdown offers. Ids that carry no recognizable quantization are
 * returned whole; so is a bare id that would otherwise strip to nothing.
 */
export function scorecardModelFamilyId(modelId: string): string {
  const stripped = modelId.replace(QUANT_SUFFIX_RE, '');
  return stripped.length > 0 ? stripped : modelId;
}

/** Platform → the three hardware groups a reader recognizes. */
const HARDWARE_LABELS: Record<string, string> = {
  darwin: 'Mac',
  win32: 'Windows',
  linux: 'Linux',
};

/** Stable filter key for a device's platform, e.g. `mac`. */
export function scorecardHardwareKey(device: ScorecardDevice): string {
  const label = HARDWARE_LABELS[device.platform];
  return (label ?? device.platform).toLowerCase();
}

/** Human name for a device's platform, e.g. `Mac`. */
export function scorecardHardwareLabel(device: ScorecardDevice): string {
  return HARDWARE_LABELS[device.platform] ?? device.platform;
}
