import { isLocalProvider } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { MODEL_INVENTORY_CHANGED_EVENT } from '../model-inventory.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { llamaEngineNeed } from './first-run-engine.js';

/**
 * Whether an unused home still needs its first working AI provider. A later
 * outage or provider change must never turn an established workshop back
 * into onboarding (and hide the diagnostics needed to repair it).
 *
 * Two signals feed it:
 *   1. An initial estimate from config + installed models, so the sidebar
 *      doesn't flash the wrong label before HomeView's probe lands. (The
 *      first-run bootstrap sets `config.provider` up front, so provider being
 *      set isn't enough — for on-device providers we check whether a model is
 *      actually installed.)
 *   2. The authoritative live value HomeView broadcasts via `gezel:first-run`
 *      after its provider probe resolves (which also re-fires when a first-run
 *      model install completes and the provider re-probes).
 * Also re-estimates on `gezel:config-updated` (e.g. provider/creds changes).
 */
async function estimateFirstRun(): Promise<boolean> {
  try {
    const cfg = await api.getConfig();
    const p = cfg.provider;
    if (!runtimeCapabilities().daemonSettings) {
      const provider = p ?? 'llama-cpp';
      const probe = await api.testProvider(provider);
      return !probe.ok || (isLocalProvider(provider) && probe.modelCount === 0);
    }
    if (p === 'copilot') {
      // Copilot's runtime is an opt-in download, so "installed" is the real
      // question — a stored PAT with no SDK on disk still can't chat. Fall
      // back to the token check only when the daemon predates the endpoint.
      const status = await api.getCopilotStatus().catch(() => null);
      return status ? !status.available : !cfg.hasGithubToken;
    }
    if (p === 'openai') return !cfg.hasOpenaiApiKey;
    if (p === 'anthropic') return !cfg.hasAnthropicApiKey;
    if (p === 'mlx') {
      const { models } = await api.listMlxModels().catch(() => ({ models: [] }));
      return models.length === 0;
    }
    if (p === 'llama-cpp' || p == null) {
      const { models } = await api.listLlamaCppModels().catch(() => ({ models: [] }));
      if (models.length === 0) return true;
      // Its engine is fetched lazily; a turn before it lands only fails.
      return p === 'llama-cpp' && (await llamaEngineNeed(cfg)) !== null;
    }
    // Ollama / CLI providers configure elsewhere — don't claim first-run for
    // them; HomeView's probe broadcast will correct it if needed.
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether this install still needs first-run setup.
 *
 * Each call costs a config read and a provider probe, repeated on every
 * settings save, so a tree with more than one consumer should share a single
 * result through {@link FirstRunContext} and pass `enabled: false` here.
 */
export function useIsFirstRun(enabled = true): boolean {
  const [firstRun, setFirstRun] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let revision = 0;
    let inFlight = false;
    let againAfter = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let completed = false;
    // The bootstrap flag is not evidence of use: the daemon sets it even
    // when setup fails. This endpoint excludes the automatically created crew
    // and projects. Read it once, shared by estimates and Home's probe events.
    const usage = api
      .getSystemHomeInfo()
      .then((home) => home.usage.everUsed)
      .catch(() => false);
    const settle = async (needsSetup: boolean, current: number) => {
      const used = await usage;
      if (cancelled || current !== revision) return;
      completed ||= used;
      const next = needsSetup && !completed;
      setFirstRun(next);
      schedulePoll(next);
    };
    const schedulePoll = (stillFirstRun: boolean) => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      // A model can finish downloading while the person is on another page,
      // where nothing announces it. Chat is held until this flips, so look
      // again now and then rather than leave the composer locked.
      if (stillFirstRun && !cancelled) pollTimer = setTimeout(recheck, FIRST_RUN_POLL_MS);
    };
    const recheck = () => {
      // An inventory answer can take a minute on a machine with large
      // models; stacking requests behind it only slows them all. A change
      // that lands meanwhile gets one fresh look once this answer is in.
      if (inFlight) {
        againAfter = true;
        return;
      }
      inFlight = true;
      const current = ++revision;
      void estimateFirstRun()
        .then((v) => {
          if (cancelled || current !== revision) return;
          return settle(v, current);
        })
        .finally(() => {
          inFlight = false;
          if (againAfter && !cancelled) {
            againAfter = false;
            recheck();
          }
        });
    };
    recheck();

    const onFirstRun = (e: Event) => {
      const detail = (e as CustomEvent<{ firstRun?: boolean }>).detail;
      if (detail && typeof detail.firstRun === 'boolean') {
        // Once Home has observed a working provider, a later failed probe is
        // a connection problem, even before the person's first saved chat.
        if (!detail.firstRun) completed = true;
        void settle(detail.firstRun, ++revision);
      }
    };
    window.addEventListener('gezel:first-run', onFirstRun);
    window.addEventListener('gezel:config-updated', recheck);
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, recheck);
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      window.removeEventListener('gezel:first-run', onFirstRun);
      window.removeEventListener('gezel:config-updated', recheck);
      window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, recheck);
    };
  }, [enabled]);

  return firstRun;
}

/** How often a first-run install looks again for a model that has landed. */
const FIRST_RUN_POLL_MS = 15_000;
