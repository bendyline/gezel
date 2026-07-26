import type { ProviderName } from '@bendyline/gezel';

/**
 * Can this model actually see the image the user just pasted, and if not, what
 * should we do about it?
 *
 * This is the first real capability gate in the codebase. Before it existed,
 * `send()` hydrated every embedded image to base64 and shipped it to whatever
 * provider was active — so a screenshot pasted at ds4 became megabytes of
 * payload that ds4-server discards, followed by a confident answer about an
 * image the model never saw.
 *
 * Split deliberately into two pure functions:
 *
 *   - {@link resolveVisionCapability} — capability only. "Can it see?"
 *   - {@link applyRecognitionPolicy}  — policy only. "Given that, what do we do?"
 *
 * Keeping them apart means ~40 combinations are exhaustively table-testable
 * without constructing a config for each, and the reason strings stay honest
 * about which layer made the call.
 */

/**
 * How a turn's images should be delivered.
 *
 *   - `native`        — the model reads pixels. Ship the bytes, inject nothing.
 *   - `preprocess`    — describe locally, inject text, and do NOT ship bytes.
 *   - `unavailable`   — nobody can see it. Static metadata plus an honest note.
 */
export type VisionVerdict = 'native' | 'preprocess' | 'unavailable';

export interface VisionPlan {
  verdict: VisionVerdict;
  /** Human-readable justification, surfaced in logs and session telemetry. */
  reason: string;
}

/**
 * Per-provider vision support.
 *
 * A total `Record` rather than a `switch` on purpose: adding an arm to
 * `ProviderNameSchema` fails typecheck here until someone classifies it, so a
 * new provider can never silently inherit "assume it can see" and start
 * dropping user images on the floor. Same trick as `ENGINE_ENV_VAR` in
 * `engines/resolver.ts`.
 */
const VISION_NATIVE: Record<ProviderName, 'always' | 'never' | 'per-model'> = {
  copilot: 'always',
  openai: 'always',
  anthropic: 'always',
  // Both drive a CLI over stdin/stdout with no attachment channel of their own.
  'anthropic-cli': 'never',
  'codex-cli': 'never',
  /**
   * Shape is right on the wire, but there's no reliable per-tag capability
   * signal without an extra `/api/show` round-trip. Conservative until there
   * is; cheap to flip.
   */
  ollama: 'never',
  'llama-cpp': 'per-model',
  mlx: 'per-model',
  /**
   * Structural, not a policy choice: `ChatModelDs4SourceSchema` has no
   * `mmproj` arm and ds4-server has no mtmd. The schema is telling us. Note
   * that `Ds4Provider` delegates to an inner `LlamaCppProvider`, so without
   * this gate attachments flow all the way to the wire and are discarded.
   */
  ds4: 'never',
  /** The far side's capability is unknown, and text is cheaper to relay. */
  remote: 'never',
};

/**
 * MLX has no vision path today — `gezel_mlx_server.py` declares vision tokens
 * explicitly out of scope, and the TS side sets an `images` field the Python
 * server ignores. One constant to flip when that lands.
 */
export const MLX_VISION_SUPPORTED = false;

export interface VisionCapabilityInput {
  provider: ProviderName;
  modelId?: string;
  /**
   * Resolved projector path for the *installed* model, i.e. exactly what
   * decides whether `--mmproj` reaches the llama-server command line.
   *
   * This is authoritative and catalog tags are not: 16 gilde chat models carry
   * a `vision`/`multimodal` tag while only a couple ship a projector, so the
   * majority install text-only. A model whose server was launched without
   * `--mmproj` is blind no matter what its weights could do.
   */
  mmprojPath?: string;
  /** Whether the user opted this model into native vision. */
  nativeVisionEnabled?: boolean;
}

export function resolveVisionCapability(input: VisionCapabilityInput): {
  native: boolean;
  reason: string;
} {
  const mode = VISION_NATIVE[input.provider];
  if (mode === 'always') return { native: true, reason: `${input.provider} accepts images` };
  if (mode === 'never') return { native: false, reason: `${input.provider} cannot accept images` };

  if (input.provider === 'mlx' && !MLX_VISION_SUPPORTED) {
    return { native: false, reason: 'the mlx engine has no vision path yet' };
  }
  if (!input.mmprojPath) {
    return {
      native: false,
      reason: input.modelId
        ? `${input.modelId} is installed without a vision projector`
        : 'no vision projector is installed for this model',
    };
  }
  if (!input.nativeVisionEnabled) {
    return {
      native: false,
      reason: 'native image support is off for this model',
    };
  }
  return { native: true, reason: `${input.modelId ?? 'this model'} runs with a vision projector` };
}

export type RecognitionMode = 'auto' | 'always' | 'off';

export interface RecognitionPolicy {
  /** Effective mode after the per-gezel override has been layered on config. */
  mode: RecognitionMode;
  /** Whether a recognition model is installed and its engine is usable. */
  recognitionAvailable: boolean;
}

export function applyRecognitionPolicy(
  capability: { native: boolean; reason: string },
  policy: RecognitionPolicy,
): VisionPlan {
  // An explicit `always` outranks native support — that's the whole point of
  // the lever. A local pass costs a few seconds and keeps pixels on the
  // machine; a frontier model's vision tokens cost money on every turn.
  if (policy.mode === 'always' && policy.recognitionAvailable) {
    return { verdict: 'preprocess', reason: 'local image scanning is set to always' };
  }
  if (capability.native) {
    return { verdict: 'native', reason: capability.reason };
  }
  if (policy.mode === 'off') {
    return { verdict: 'unavailable', reason: `${capability.reason}; local scanning is off` };
  }
  if (policy.recognitionAvailable) {
    return { verdict: 'preprocess', reason: capability.reason };
  }
  return {
    verdict: 'unavailable',
    reason: `${capability.reason}, and no local image reader is installed`,
  };
}

/** Convenience for the chat path, which always has both halves to hand. */
export function resolveImageStrategy(
  input: VisionCapabilityInput,
  policy: RecognitionPolicy,
): VisionPlan {
  return applyRecognitionPolicy(resolveVisionCapability(input), policy);
}
