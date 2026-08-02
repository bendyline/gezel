import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Whether the app is still in first-run onboarding — no working AI provider
 * set up yet. Drives relabeling the Meester home tab as "Get started" until
 * the user has downloaded a model / connected a provider.
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
    if (p === 'copilot') {
      // Copilot's runtime is an opt-in download, so "installed" is the real
      // question — a stored PAT with no SDK on disk still can't chat. Fall
      // back to the token check only when the daemon predates the endpoint.
      const status = await api.getCopilotStatus().catch(() => null);
      return status ? !status.available : !cfg.hasGithubToken;
    }
    if (p === 'openai') return !cfg.hasOpenaiApiKey;
    if (p === 'mlx') {
      const { models } = await api.listMlxModels().catch(() => ({ models: [] }));
      return models.length === 0;
    }
    if (p === 'llama-cpp' || p == null) {
      const { models } = await api.listLlamaCppModels().catch(() => ({ models: [] }));
      return models.length === 0;
    }
    // Ollama / CLI providers configure elsewhere — don't claim first-run for
    // them; HomeView's probe broadcast will correct it if needed.
    return false;
  } catch {
    return false;
  }
}

export function useIsFirstRun(): boolean {
  const [firstRun, setFirstRun] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const recheck = () => {
      void estimateFirstRun().then((v) => {
        if (!cancelled) setFirstRun(v);
      });
    };
    recheck();

    const onFirstRun = (e: Event) => {
      const detail = (e as CustomEvent<{ firstRun?: boolean }>).detail;
      if (detail && typeof detail.firstRun === 'boolean') setFirstRun(detail.firstRun);
    };
    window.addEventListener('gezel:first-run', onFirstRun);
    window.addEventListener('gezel:config-updated', recheck);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:first-run', onFirstRun);
      window.removeEventListener('gezel:config-updated', recheck);
    };
  }, []);

  return firstRun;
}
