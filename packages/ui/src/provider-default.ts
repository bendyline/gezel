import type { ProviderName } from '@bendyline/gezel';

/**
 * Placeholder provider for the instant before `GET /api/config` answers.
 *
 * The daemon already resolves the real default (see `resolveDefaultProviderName`
 * service-side) and returns it on every config read, so this value is only ever
 * visible for one render — or when the config fetch fails outright.
 *
 * It used to be `'copilot'`, which stopped being safe once the Copilot runtime
 * became an opt-in download: a fresh install would briefly render
 * Copilot-specific affordances for a provider it had no way to run. An
 * on-device engine is the honest placeholder, and it matches what the daemon
 * will say on every platform we bundle an engine for.
 */
export const UI_FALLBACK_PROVIDER: ProviderName = 'llama-cpp';
