/**
 * Working without a paired server that went away.
 *
 * A gezel can run on a model hosted by another device on the network. When
 * that device sleeps or this one leaves its network, its work runs on this
 * install's own provider instead, and the reply says so; once the server is
 * reachable again the next turn goes back to it. These are the pure parts:
 * which paired server a route uses, and the sentences a person reads.
 */

import type { GezelConfig, ProviderName } from '@bendyline/gezel';
import { parseRemoteModelId } from '../providers/remote/model-id.js';

/**
 * The paired server a remote-routed gezel uses, following the precedence
 * `effectiveSessionModel` applies to the model itself: a model pinned on the
 * gezel, then the Night Shift override, then the install default.
 */
export function remoteIdForRoute(args: {
  frontmatterModel?: string;
  nightOverride?: { provider?: ProviderName; model?: string };
  config: Pick<GezelConfig, 'defaultModel'>;
}): string | undefined {
  const model =
    args.frontmatterModel ??
    (args.nightOverride?.provider === 'remote' ? args.nightOverride.model : undefined) ??
    args.config.defaultModel?.remote;
  return model ? parseRemoteModelId(model)?.remoteId : undefined;
}

/** A model pinned on a gezel that only a paired server can run. */
export function isRemoteOnlyModel(model: string | undefined): boolean {
  return model !== undefined && parseRemoteModelId(model) !== null;
}

const ON_DEVICE: ReadonlySet<ProviderName> = new Set([
  'llama-cpp',
  'mlx',
  'ds4',
  'apple-foundation-models',
  'android-mlkit',
]);

function answeredBy(provider: ProviderName): string {
  if (ON_DEVICE.has(provider)) return "this computer's own model";
  switch (provider) {
    case 'ollama':
      return 'Ollama on this computer';
    case 'copilot':
      return 'Copilot';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Claude';
    case 'anthropic-cli':
      return 'Claude CLI';
    case 'codex-cli':
      return 'Codex CLI';
    default:
      return provider;
  }
}

export function remoteFallbackNotice(remoteName: string, fallback: ProviderName): string {
  return `${remoteName} isn't reachable, so ${answeredBy(fallback)} answered instead. Gezel switches back once ${remoteName} is reachable again.`;
}

export function remoteReturnNotice(remoteName: string): string {
  return `${remoteName} is reachable again and answered this one.`;
}
