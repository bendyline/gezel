import { isLocalProvider } from './schemas/gezel.js';
import type { ProviderName } from './schemas/gezel.js';

/**
 * Which connections keep what they bring in on models that run on this
 * computer until the person allows cloud ones.
 *
 * Google's Workspace policy lets an app pass Workspace data on only for a
 * feature the person is using and only with their consent, so a Google
 * account's mail, calendar and files start here. The list is code, not
 * catalog content: a manifest must not be able to decide that the person's
 * consent is unnecessary. A camera has its own switch for its pictures
 * (`connectors/live/camera/frame-access.ts`).
 */
const ASKS_BEFORE_CLOUD: ReadonlySet<string> = new Set([
  'calendar-google',
  'files-google-drive',
  'mail-gmail',
]);

/** Whether connections of this type ask before a cloud model may read them. */
export function connectorAsksBeforeCloud(type: string): boolean {
  return ASKS_BEFORE_CLOUD.has(type);
}

/** Whether this connection's data is kept on models that run on this computer. */
export function connectionKeepsLocal(binding: {
  type: string;
  allowCloudModels?: boolean | undefined;
}): boolean {
  return connectorAsksBeforeCloud(binding.type) && binding.allowCloudModels !== true;
}

/**
 * Whether a model runs on this computer, for data that must stay here. A
 * paired computer (`remote`) is somewhere else. Ollama can be too, behind a
 * provider name that reads as local: its hosted models (`gpt-oss:120b-cloud`)
 * answer from its servers through the local process, and its address can be
 * another machine's.
 */
export function modelRunsOnThisComputer(
  provider: ProviderName | undefined,
  model?: string | undefined,
  opts: { ollamaBaseUrl?: string | undefined } = {},
): boolean {
  if (!provider || !isLocalProvider(provider)) return false;
  if (provider !== 'ollama') return true;
  return !isOllamaHostedModel(model) && isLoopbackUrl(opts.ollamaBaseUrl);
}

/** Ollama names its hosted models with a `cloud` tag or tag suffix. */
export function isOllamaHostedModel(model: string | undefined): boolean {
  return !!model && /(?::|-)cloud$/i.test(model.trim());
}

/** Unset means Ollama's own default, which is this computer. */
function isLoopbackUrl(raw: string | undefined): boolean {
  if (!raw?.trim()) return true;
  try {
    const host = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}
