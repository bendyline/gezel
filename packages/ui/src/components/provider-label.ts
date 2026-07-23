/**
 * Platform-aware provider label resolver — the shared source of truth
 * for "what user-visible name is this provider known by in the UI."
 *
 * The wrinkle is `llama-cpp`: it's our cross-platform on-device engine,
 * but the *concept* the user reaches for ("the AI running on this
 * computer") reads better with a platform-specific name. On macOS it
 * coexists with MLX (which owns the "This Mac" slot already), so on
 * darwin we fall back to the technical name. Windows and Linux get
 * "This Windows PC" / "This Linux device" — names that mirror how the
 * Settings sidebar groups the provider's tab.
 *
 * Use this from any UI surface that renders a provider name. Don't
 * inline the switch — drift between the QueueMeter pill, the
 * SessionSwitcher dropdown, and the engine status pill is exactly
 * what this module prevents.
 *
 * Pass `platform` from `window.__GEZEL__?.platform` (process.platform
 * exposed via the preload bridge). Optional: callers in contexts
 * without bridge access (tests, plain web build) can omit it; the
 * llama-cpp branch falls through to the technical name in that case.
 */

import type { ProviderName } from '@bendyline/gezel';

export interface ProviderLabelOptions {
  /**
   * When true, return the most-abbreviated form that still identifies
   * the provider: "Windows" / "Linux" / "Mac" instead of "This Windows
   * PC" / "This Linux device" / "This Mac"; "Claude" instead of
   * "Claude CLI"; "Codex" instead of "Codex CLI". Cloud providers
   * with already-short names ("Copilot", "OpenAI", "Ollama") return
   * unchanged.
   *
   * Used by the QueueMeter pill in the header where a long label
   * wraps to multiple lines on narrow titlebars (a user screenshot
   * showed "THIS WINDOWS PC" stacking over 3 rows). The full label remains
   * canonical everywhere else (Settings tabs, SessionSwitcher, etc.).
   */
  compact?: boolean;
}

export function providerLabel(
  provider: ProviderName,
  platform?: string,
  opts: ProviderLabelOptions = {},
): string {
  const compact = opts.compact ?? false;
  switch (provider) {
    case 'copilot':
      return 'Copilot';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Claude';
    case 'anthropic-cli':
      return compact ? 'Claude' : 'Claude CLI';
    case 'codex-cli':
      return compact ? 'Codex' : 'Codex CLI';
    case 'ollama':
      return 'Ollama';
    case 'mlx':
      return compact ? 'Mac' : 'This Mac';
    case 'ds4':
      return compact ? 'ds4' : 'DwarfStar';
    case 'llama-cpp':
      if (platform === 'win32') return compact ? 'Windows' : 'This Windows PC';
      if (platform === 'linux') return compact ? 'Linux' : 'This Linux device';
      // macOS fallback: MLX already owns "This Mac", so llama-cpp on
      // darwin reads as the cross-platform engine — distinct enough
      // that the two tabs don't collide. Web/tests with no platform
      // info land here too; "On-device" is generic but not wrong.
      return compact ? 'Local' : 'On-device';
    default:
      return provider;
  }
}
