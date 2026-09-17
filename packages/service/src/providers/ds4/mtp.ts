/**
 * Model-embedded multi-token prediction for ds4 (`--mtp`).
 *
 * Qwen3.8 Flash Next and GLM 5.3 carry their draft block inside the language
 * GGUF, unlike DeepSeek DSpark's external `--mtp-model` companion. Catalog
 * presence is therefore both a capability declaration and the `auto` opt-in:
 * older/unknown GGUFs never receive a flag they may reject.
 */

export type Ds4MtpMode = 'off' | 'on' | 'auto';

export interface Ds4EmbeddedMtpCatalog {
  /** Pass `--mtp-exact-sampling` so non-zero-temperature requests stay distribution-correct. */
  exactSampling?: boolean;
}

export interface Ds4MtpOptions {
  /** `config.ds4Mtp`. Absent means `auto`. */
  mode?: Ds4MtpMode;
  /** Embedded-MTP capability declared by the selected catalog source. */
  catalog?: Ds4EmbeddedMtpCatalog;
  /** Optional operator override; absent inherits the catalog recommendation. */
  exactSampling?: boolean;
  /** External DSpark and embedded MTP are alternative draft paths, never stacked. */
  dsparkEnabled?: boolean;
}

export interface Ds4MtpDecision {
  enabled: boolean;
  exactSampling: boolean;
  reason: string;
  /** Populated only when an explicit `on` request could not be honored. */
  unmetRequest?: string;
}

export function resolveDs4Mtp(opts: Ds4MtpOptions): Ds4MtpDecision {
  const mode = opts.mode ?? 'auto';
  const exactSampling = opts.exactSampling ?? opts.catalog?.exactSampling ?? false;

  if (mode === 'off') {
    return { enabled: false, exactSampling: false, reason: 'disabled by config (ds4Mtp=off)' };
  }

  if (opts.dsparkEnabled) {
    return {
      enabled: false,
      exactSampling: false,
      reason: 'external DSpark is active; embedded MTP is an alternative draft path',
      ...(mode === 'on'
        ? {
            unmetRequest:
              'ds4Mtp=on cannot be combined with the active DSpark support model. Disable ds4Dspark or select a model with embedded MTP and no external draft companion.',
          }
        : {}),
    };
  }

  if (mode === 'auto' && !opts.catalog) {
    return {
      enabled: false,
      exactSampling: false,
      reason: 'auto: selected catalog model does not declare embedded MTP',
    };
  }

  return {
    enabled: true,
    exactSampling,
    reason:
      mode === 'on'
        ? 'enabled by config (ds4Mtp=on)'
        : `auto: catalog declares embedded MTP${exactSampling ? ' with exact sampling' : ''}`,
  };
}

export function ds4MtpArgs(decision: Ds4MtpDecision): string[] {
  if (!decision.enabled) return [];
  return ['--mtp', ...(decision.exactSampling ? ['--mtp-exact-sampling'] : [])];
}
