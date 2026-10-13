import type { Project } from '@bendyline/gezel';
import { displayName, isLocalProvider } from '@bendyline/gezel';
import type { ProviderName } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateState } from '../api.js';
import { api } from '../api.js';
import { useFirstRun } from '../components/first-run-context.js';
import { llamaEngineNeed } from '../components/first-run-engine.js';
import { useFirstRunModel } from '../components/useFirstRunModel.js';
import { useRoleBasedNameOnlyMode } from '../components/useRoleBasedNameOnlyMode.js';
import { releaseUrl } from '../github-urls.js';
import { UI_FALLBACK_PROVIDER } from '../provider-default.js';
import { useUpdateState } from '../update-state.js';
import '../styles/home-view.css';
import { HomeWorkshop } from './home/HomeWorkshop.js';
import type { WelcomeSetup } from './home/MeesterWelcome.js';

type Provider = ProviderName;

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'probing'; retryAttempt?: number; retryMax?: number }
  | { kind: 'ok'; modelCount: number }
  | { kind: 'fail'; error: string };

/** Ollama polling cadence. Covers two scenarios:
 *    1. Cold-start warmup: Ollama is installed but hasn't bound its
 *       port yet (10–20s typical). The server-side auto-start burns
 *       ~9s of budget; we pick up right after.
 *    2. "Install later" flow: user lands on the Home tab, decides to
 *       go grab Ollama from the website, installs, starts it, and
 *       comes back to Gezel. We want the probe to notice without
 *       anyone clicking anything.
 *  20s × 720 gives a 4-hour patience window — a localhost HTTP ping
 *  every 20s is cheap and the cleanup path cancels the timer when the
 *  user switches providers or leaves the view. */
const OLLAMA_RETRY_INTERVAL_MS = 20_000;
const OLLAMA_MAX_RETRIES = 720;

/**
 * The first screen a user sees: the meester's workshop. During first run the
 * workshop's conversation opens on the meester's welcome, which carries the
 * one thing setup still needs (an AI model) in the meester's own voice; when
 * the model lands the same surface carries on, with no change of page.
 */
export function HomeView({
  platform,
  onNavigate,
}: {
  platform?: string;
  onNavigate?: (
    view:
      | 'home'
      | 'gezels'
      | 'projects'
      | 'documents'
      | 'tasks'
      | 'scripts'
      | 'history'
      | 'settings',
  ) => void;
}) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [meesterName, setMeesterName] = useState<string | undefined>(undefined);
  const [meesterRoleBasedName, setMeesterRoleBasedName] = useState<string | undefined>(undefined);
  const [meesterIcon, setMeesterIcon] = useState<string | null>(null);
  const [meesterPoppetje, setMeesterPoppetje] = useState<
    import('@bendyline/gezel').Poppetje | null
  >(null);
  const [meesterIconOverride, setMeesterIconOverride] = useState<boolean>(false);
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const meesterDisplayName = meesterName
    ? displayName({ name: meesterName, roleBasedName: meesterRoleBasedName }, roleBasedNameOnlyMode)
    : undefined;
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  // The settled verdict on whether setup is done — `false` means the welcome
  // still asks for tools. `null` while we're still determining it, which
  // holds the loading splash. Made *sticky* on purpose: it only ever changes
  // on a *terminal* probe (ok/fail) or when we know a credential provider has
  // no creds. A background re-probe flips `probe` back to 'probing' but must
  // NOT bounce the view between first run and chat — the two bugs this fixes
  // were (1) a slow cold boot showing setup for seconds before the llama.cpp
  // probe landed, and (2) that same flip flickering repeatedly while things
  // churned on boot.
  const [configured, setConfigured] = useState<boolean | null>(null);
  const needsFirstSetup = useFirstRun();

  useEffect(() => {
    let cancelled = false;
    // Config is load-bearing for deciding workshop vs. first-run, so on a
    // cold boot — where the service may still be binding its port — retry
    // until it lands rather than stranding on the loading splash. Everything
    // downstream waits on `config`, so the splash simply persists until this
    // succeeds.
    let attempt = 0;
    const loadConfig = () => {
      api
        .getConfig()
        .then((cfg) => {
          if (!cancelled) setConfig(cfg);
        })
        .catch(() => {
          if (cancelled || attempt >= 40) return;
          attempt += 1;
          window.setTimeout(loadConfig, 500);
        });
    };
    loadConfig();
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = config?.meesterGezelId;
    if (!id) {
      setMeesterName(undefined);
      setMeesterRoleBasedName(undefined);
      setMeesterIcon(null);
      setMeesterPoppetje(null);
      setMeesterIconOverride(false);
      return;
    }
    api
      .listGezels()
      .then((r) => {
        const g = r.gezels.find((g) => g.id === id);
        setMeesterName(g?.name);
        setMeesterRoleBasedName(g?.roleBasedName);
        setMeesterIcon(g?.icon ?? null);
        setMeesterPoppetje(g?.poppetje ?? null);
        setMeesterIconOverride(g?.iconOverride ?? false);
      })
      .catch(() => {});
  }, [config?.meesterGezelId]);

  const provider: Provider = config?.provider ?? UI_FALLBACK_PROVIDER;
  const hasCreds =
    provider === 'copilot'
      ? Boolean(config?.hasGithubToken)
      : provider === 'openai'
        ? Boolean(config?.hasOpenaiApiKey)
        : provider === 'anthropic'
          ? Boolean(config?.hasAnthropicApiKey)
          : // Ollama has no credential — the base URL is its "connection".
            // Treat it as always configured; the probe tells us if the server
            // is actually reachable.
            true;

  // Auto-probe once config loads — gives the user a green checkmark
  // without clicking. Copilot can authenticate via the SDK's own flow
  // (gh auth / device code) without a stored token. Ollama has no
  // credential at all. Both can be probed immediately. OpenAI and Anthropic
  // strictly need an API key, so wait until one is saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-probe only when the specific config fields change — not on every probe-state or derived-hasCreds tick.
  useEffect(() => {
    if (!config) return;
    if (probe.kind !== 'idle') return;
    if (provider === 'copilot' || provider === 'ollama' || hasCreds) {
      void runProbe(provider);
    }
  }, [
    config?.provider,
    config?.hasGithubToken,
    config?.hasOpenaiApiKey,
    config?.hasAnthropicApiKey,
    config?.ollamaBaseUrl,
  ]);

  // Retry timer for Ollama's cold-start window. Held in a ref so provider
  // changes / unmounts cancel it cleanly.
  const ollamaRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelOllamaRetries = useCallback(() => {
    if (ollamaRetryTimer.current) {
      clearTimeout(ollamaRetryTimer.current);
      ollamaRetryTimer.current = null;
    }
  }, []);

  const runProbe = useCallback(
    async (p: Provider, retryAttempt = 0) => {
      cancelOllamaRetries();
      setProbe(
        retryAttempt > 0
          ? { kind: 'probing', retryAttempt, retryMax: OLLAMA_MAX_RETRIES }
          : { kind: 'probing' },
      );
      try {
        const res = await api.testProvider(p);
        if (res.ok) {
          setProbe({ kind: 'ok', modelCount: res.modelCount });
          return;
        }
        // Ollama cold-start grace: the server already tried to auto-start it,
        // but a fresh Ollama install can take 15-20s to bind the port. Keep
        // polling until it comes up or we hit the retry cap.
        const shouldRetry =
          p === 'ollama' && config?.autoStartOllama !== false && retryAttempt < OLLAMA_MAX_RETRIES;
        if (shouldRetry) {
          ollamaRetryTimer.current = setTimeout(() => {
            void runProbe(p, retryAttempt + 1);
          }, OLLAMA_RETRY_INTERVAL_MS);
          setProbe({
            kind: 'probing',
            retryAttempt: retryAttempt + 1,
            retryMax: OLLAMA_MAX_RETRIES,
          });
          return;
        }
        setProbe({ kind: 'fail', error: res.error });
      } catch (err) {
        setProbe({ kind: 'fail', error: (err as Error).message });
      }
    },
    [cancelOllamaRetries, config?.autoStartOllama],
  );

  useEffect(() => () => cancelOllamaRetries(), [cancelOllamaRetries]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void api
        .getConfig()
        .then((next) => {
          if (cancelled) return;
          setConfig(next);
          void runProbe(next.provider ?? UI_FALLBACK_PROVIDER);
        })
        .catch(() => {});
    };
    window.addEventListener('gezel:config-updated', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:config-updated', refresh);
    };
  }, [runProbe]);

  // A healthy local engine is not yet usable without a model on disk. Keep
  // every local provider in onboarding until its inventory is non-empty so
  // the first-run download affordance remains visible. Cloud/frontier
  // providers are different: an empty list can be a valid API response and
  // must not send an already-connected user back through first run.
  const localProviderNeedsModel =
    isLocalProvider(provider) && probe.kind === 'ok' && probe.modelCount === 0;

  // Settle the sticky verdict off *terminal* probes only. A re-probe flips
  // `probe` back to 'probing' (e.g. after a first-run model install), but we
  // leave the last verdict standing so the view doesn't bounce.
  // A llama.cpp model on disk still needs the engine that runs it, which the
  // daemon fetches lazily. Settling "configured" before it arrived let the
  // welcome say "I'm ready" and the first message fail on the download.
  const [engineCheck, setEngineCheck] = useState<{
    probe: ProbeState;
    provider: Provider;
    missing: boolean;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-ask only when the probe settles or the backend choice changes, not on every config read.
  useEffect(() => {
    if (probe.kind !== 'ok') return;
    if (provider !== 'llama-cpp' || localProviderNeedsModel) {
      setEngineCheck({ probe, provider, missing: false });
      return;
    }
    let cancelled = false;
    void llamaEngineNeed(config).then((need) => {
      if (!cancelled) setEngineCheck({ probe, provider, missing: Boolean(need) });
    });
    return () => {
      cancelled = true;
    };
  }, [probe, provider, localProviderNeedsModel, config?.llamaCppBackendOverride]);

  useEffect(() => {
    if (probe.kind === 'ok') {
      if (engineCheck?.probe !== probe || engineCheck.provider !== provider) return;
      setConfigured(!localProviderNeedsModel && !engineCheck.missing);
    } else if (probe.kind === 'fail') setConfigured(false);
  }, [probe, provider, localProviderNeedsModel, engineCheck]);

  // Credential providers with no creds (OpenAI / Anthropic before a key is
  // saved) are never auto-probed — there's nothing to wait for, so resolve
  // them straight to first-run instead of holding the splash indefinitely.
  const willProbe = provider === 'copilot' || provider === 'ollama' || hasCreds;
  useEffect(() => {
    if (config && !willProbe) setConfigured(false);
  }, [config, willProbe]);

  // Last-resort anti-strand guard: if the probe is genuinely wedged (a server
  // that accepts the connection but never answers /api/models/test), don't
  // leave the user on the loading splash forever — fall through to first-run
  // so they can act. The window is deliberately generous (30s) so it never
  // fires during a normal cold boot: local probes resolve in well under a
  // second, and even a Copilot SDK cold-start clears it in the common case.
  // This is the safety net the old 2.5s splash cap provided — minus the
  // premature-first-run flash, since the sticky verdict never regresses once
  // a real probe lands.
  useEffect(() => {
    if (configured !== null) return;
    const t = window.setTimeout(() => setConfigured(false), 30_000);
    return () => window.clearTimeout(t);
  }, [configured]);

  // Broadcast the first-run (not-yet-configured) state so the sidebar can
  // relabel the Meester home tab "Get started" until setup is done. Fires only
  // once the verdict has settled — during the loading window the sidebar's own
  // config estimate stands, so we don't flash the wrong label on cold boot.
  useEffect(() => {
    if (configured === null) return;
    window.dispatchEvent(new CustomEvent('gezel:first-run', { detail: { firstRun: !configured } }));
  }, [configured]);

  // Re-probe once the first-run model lands. Kept stable: the download's
  // inventory check depends on it, and a fresh identity every render would
  // restart that check on every render.
  const reprobeCurrentProvider = useCallback(() => {
    void runProbe(provider);
  }, [runProbe, provider]);

  const updateState = useUpdateState();
  const banner = <UpdateBanner state={updateState} platform={platform} />;

  // First run, confirmed by a terminal probe. The welcome's tools beat waits
  // for this, so a configured install never flashes a download offer.
  const firstRun = configured === false && needsFirstSetup;
  const hostModels = window.__GEZEL__?.renderModelSettings;
  const firstRunModel = useFirstRunModel({
    enabled: firstRun && !hostModels,
    config,
    onConfigChanged: setConfig,
    onModelInstalled: reprobeCurrentProvider,
  });
  const setup: WelcomeSetup | null = firstRun
    ? { model: firstRunModel, ...(hostModels ? { hostModels } : {}) }
    : null;

  // The model landed while the person watched: the welcome says so, and
  // Home keeps the welcome's quiet layout for the rest of this visit.
  const sawFirstRunRef = useRef(false);
  const [justReady, setJustReady] = useState(false);
  useEffect(() => {
    if (firstRun) sawFirstRunRef.current = true;
    else if (configured === true && sawFirstRunRef.current) setJustReady(true);
  }, [configured, firstRun]);

  // Hold the loading splash until the verdict has actually settled — never
  // guess first-run-vs-workshop while config is still loading or the probe is
  // mid-flight, or a configured install would flash a download offer. The
  // placeholder fades in only after a delay (see .home-loading-placeholder)
  // so a fast boot shows an empty surface rather than a spinner blink.
  if (!config || configured === null) {
    return (
      <div className="home-view home-view-loading" aria-busy="true">
        <div className="home-loading-placeholder" aria-live="polite">
          <span className="home-loading-spinner" aria-hidden />
        </div>
      </div>
    );
  }

  return (
    <HomeWorkshop
      config={config}
      projects={projects}
      meesterGezelId={config?.meesterGezelId}
      meesterName={meesterDisplayName ?? 'your meester'}
      meesterIcon={meesterIcon}
      meesterPoppetje={meesterPoppetje}
      meesterIconOverride={meesterIconOverride}
      banner={banner}
      setup={setup}
      justReady={justReady}
      onNavigate={onNavigate}
    />
  );
}

// ─────────────────────────────────────────────────────────────────
/**
 * The "an update is waiting for you" prompt — the one update outcome that is
 * both actionable and worth interrupting for. Every *failure* (a check that
 * could not reach GitHub, an install that could not be applied) is an
 * install-health notice instead: quiet in the navigation rail under Settings,
 * explained in Settings → About. See system-notices.ts for why.
 *
 * On macOS "Install" opens a verified PKG so Installer.app can authenticate;
 * Windows defers to its signed NSIS handoff. Linux only links to the release.
 */
function UpdateBanner({ state, platform }: { state: UpdateState | null; platform?: string }) {
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  if (!state || (state.kind !== 'available' && state.kind !== 'ready')) return null;

  if (state.kind === 'available') {
    return (
      <output className="app-fallback-banner" data-testid="update-banner">
        <strong>Gezel {state.version} is available.</strong>
        <span>
          Linux updates are installed manually. Open the GitHub release, verify its SLSA build
          provenance, then install the package for your distribution.
        </span>
        <div className="app-fallback-banner-actions">
          <a className="app-update-release-link" href={releaseUrl(state.version)}>
            Open release and verification steps
          </a>
        </div>
      </output>
    );
  }

  return (
    <output className="app-fallback-banner" data-testid="update-banner">
      <strong>Gezel {state.version} is ready to install.</strong>
      <span>
        {platform === 'darwin'
          ? 'Installing replaces Gezel and its background service together, so macOS will ask for an administrator password.'
          : 'The update will install automatically after you quit Gezel completely. Closing the window may leave Gezel running in the system tray.'}
      </span>
      <div className="app-fallback-banner-actions">
        <button
          type="button"
          className="primary"
          disabled={installing}
          onClick={() => {
            setInstalling(true);
            setInstallError(null);
            void window.__GEZEL__?.update?.install().then((r) => {
              if (!r.ok) {
                setInstallError(r.error);
                setInstalling(false);
              }
            });
          }}
        >
          {installing
            ? platform === 'darwin'
              ? 'Opening installer…'
              : 'Restarting…'
            : platform === 'darwin'
              ? 'Open installer'
              : 'Install and restart'}
        </button>
      </div>
      {installError && (
        <details open>
          <summary>Could not open the installer</summary>
          <p>{installError}</p>
        </details>
      )}
    </output>
  );
}
