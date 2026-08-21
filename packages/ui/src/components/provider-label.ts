/**
 * Platform-aware provider label resolver — the shared source of truth
 * for "what user-visible name is this provider known by in the UI."
 *
 * The wrinkle is `llama-cpp`: it's our cross-platform on-device engine,
 * but the *concept* the user reaches for ("the AI running on this
 * computer") reads better with a platform-specific name — "This Mac",
 * "This PC", "This Device". Every local engine uses that same name, so
 * on macOS a llama.cpp pill reads "This Mac" exactly like an MLX one;
 * when both are visible the model name in each pill's label and popover
 * is what tells them apart. The alternative — one engine wearing the
 * platform name and the other a technical one — made the second pill
 * look like a different kind of thing rather than a second engine.
 *
 * Use this from any UI surface that renders a provider name. Don't
 * inline the switch — drift between the QueueMeter pill, the
 * SessionSwitcher dropdown, and the engine status pill is exactly
 * what this module prevents.
 *
 * Pass `platform` from `window.__GEZEL__?.platform` (process.platform
 * exposed via the preload bridge). Optional: callers in contexts
 * without bridge access (tests, plain web build) can omit it; the
 * machine-named branches fall back to the generic "This Device".
 */

import type { ProviderName } from '@bendyline/gezel';

export interface ProviderLabelOptions {
  /**
   * When true, return the most-abbreviated form that still identifies
   * the provider: "Windows" / "Linux" / "Mac" instead of "This PC" /
   * "This Device" / "This Mac"; "Claude" instead of "Claude CLI";
   * "Codex" instead of "Codex CLI". Cloud providers with already-short
   * names ("Copilot", "OpenAI", "Ollama") return unchanged.
   *
   * Used by the QueueMeter pill in the header where a long label
   * wraps to multiple lines on narrow titlebars (a user screenshot
   * showed "THIS WINDOWS PC" stacking over 3 rows). The full label remains
   * canonical everywhere else (Settings tabs, SessionSwitcher, etc.).
   */
  compact?: boolean;
}

/**
 * "This Mac" / "This PC" / "This Device" — what the user calls the
 * computer they are sitting at. Every surface that names the machine
 * itself (rather than a specific engine) goes through here so the
 * wording can't drift between the header pill, the Settings tabs and
 * the model dropdowns.
 *
 * `platform` is `process.platform` as exposed by the preload bridge
 * (`window.__GEZEL__?.platform`). With no bridge — plain web build,
 * tests — we can't know the machine, so the generic "This Device"
 * stands in; it's vague but never wrong.
 */
export function deviceLabel(platform?: string, opts: ProviderLabelOptions = {}): string {
  const compact = opts.compact ?? false;
  if (platform === 'darwin') return compact ? 'Mac' : 'This Mac';
  if (platform === 'win32') return compact ? 'Windows' : 'This PC';
  if (platform === 'linux') return compact ? 'Linux' : 'This Device';
  return compact ? 'Local' : 'This Device';
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
      // MLX is Apple-only, so the platform argument is redundant here;
      // pinning darwin keeps the label right in the plain web build too.
      return deviceLabel('darwin', { compact });
    case 'ds4':
      return compact ? 'ds4' : 'DwarfStar';
    case 'llama-cpp':
      return deviceLabel(platform, { compact });
    default:
      return provider;
  }
}
