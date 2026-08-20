import type { HealthResponse, Project, SecurityPresetLevel } from '@bendyline/gezel';
import { displayName, isLocalProvider, securityPolicyForLevel } from '@bendyline/gezel';
import type { ProviderName } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateState } from '../api.js';
import { api } from '../api.js';
import gezelLogotypeUrl from '../assets/gezellogotype.png';
import { FirstRunInstallBanner } from '../components/FirstRunInstallBanner.js';
import { RecommendedMediaDownloads } from '../components/RecommendedMediaDownloads.js';
import { useRoleBasedNameOnlyMode } from '../components/useRoleBasedNameOnlyMode.js';
import { UI_FALLBACK_PROVIDER } from '../provider-default.js';
import { SECURITY_LEVEL_PRESETS } from '../security-levels.js';
import { requestSettingsSection } from '../settings-nav.js';
import { useUpdateState } from '../update-state.js';
import '../styles/08-home-view.css';
import { HomeWorkshop } from './home/HomeWorkshop.js';
import { IntroHandboekArticle } from './home/IntroHandboekArticle.js';
import { FIRST_RUN_INTRO_ANCHOR_ID } from './home/first-run-intro-anchor.js';

type Provider = ProviderName;

/**
 * The on-device engine differs by platform: Mac → MLX (Apple-native,
 * faster on Apple Silicon), Windows/Linux → llama.cpp. SettingsView has
 * a more elaborate version of this; the Home tab only ever shows the
 * one that's right for the current OS.
 */
function onDeviceProviderForPlatform(platform: string | undefined): 'mlx' | 'llama-cpp' {
  return platform === 'darwin' ? 'mlx' : 'llama-cpp';
}

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
 * The first screen a user sees. Three stacked sections:
 *   1. Intro — what gezels are and how to use the app. Compact once
 *      the user is past setup + has done anything.
 *   2. Setup — provider credentials with a "Test connection" green
 *      checkmark, plus a runtime sanity check (node version, daemon).
 *   3. Meester chat — always present; becomes the dominant surface once
 *      the user is onboarded.
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
  const [health, setHealth] = useState<HealthResponse | null>(null);
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
  const [collapseIntro, setCollapseIntro] = useState<boolean | null>(null);
  // The settled verdict on whether setup is done — `true` → workshop, `false`
  // → first-run onboarding. `null` while we're still determining it, which
  // holds the loading splash. Made *sticky* on purpose: it only ever changes
  // on a *terminal* probe (ok/fail) or when we know a credential provider has
  // no creds. A background re-probe flips `probe` back to 'probing' but must
  // NOT bounce the view first-run ↔ chat — the two bugs this fixes were
  // (1) a slow cold boot showing "First run setup" for seconds before the
  // llama.cpp probe landed and flipped to chat, and (2) that same flip
  // flickering repeatedly while things churned on boot.
  const [configured, setConfigured] = useState<boolean | null>(null);

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
      .health()
      .then(setHealth)
      .catch(() => {});
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
  // Resolve the effective default model name for the banner. For
  // llama-cpp, when the user hasn't pinned a default, the supervisor
  // falls through to the first installed model (see
  // `LlamaCppModelManager.resolveDefaultModelPath`). Match that here
  // so the banner reads "using On-device gemma-4-E2B by default"
  // instead of a bare "using On-device by default".
  const configuredDefaultModel = config?.defaultModel?.[provider];
  const [llamaCppAutoModel, setLlamaCppAutoModel] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (provider !== 'llama-cpp' || configuredDefaultModel) {
      setLlamaCppAutoModel(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.listLlamaCppModels();
        if (!cancelled) setLlamaCppAutoModel(res.models[0]?.name);
      } catch {
        /* non-fatal — banner just omits the model name */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, configuredDefaultModel]);
  const effectiveDefaultModel = configuredDefaultModel ?? llamaCppAutoModel;
  const hasCreds =
    provider === 'copilot'
      ? Boolean(config?.hasGithubToken)
      : provider === 'openai'
        ? Boolean(config?.hasOpenaiApiKey)
        : // Ollama has no credential — the base URL is its "connection".
          // Treat it as always configured; the probe tells us if the server
          // is actually reachable.
          true;

  // Auto-probe once config loads — gives the user a green checkmark
  // without clicking. Copilot can authenticate via the SDK's own flow
  // (gh auth / device code) without a stored token. Ollama has no
  // credential at all. Both can be probed immediately. OpenAI strictly
  // needs an API key, so wait until one is saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-probe only when the specific config fields change — not on every probe-state or derived-hasCreds tick.
  useEffect(() => {
    if (!config) return;
    if (probe.kind !== 'idle') return;
    if (provider === 'copilot' || provider === 'ollama' || hasCreds) {
      void runProbe(provider);
    }
  }, [config?.provider, config?.hasGithubToken, config?.hasOpenaiApiKey, config?.ollamaBaseUrl]);

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
  useEffect(() => {
    if (probe.kind === 'ok') setConfigured(!localProviderNeedsModel);
    else if (probe.kind === 'fail') setConfigured(false);
  }, [probe.kind, localProviderNeedsModel]);

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

  // Stable callback for the local-engine model managers'
  // `onModelsChanged` prop. An inline arrow re-creates each render,
  // which would push a new ref into LlamaCppModelManager whose own
  // refresh useCallback then regenerates and re-fires its mount
  // effect — a loop that hammers /api/llama-cpp/models 60×/s. The
  // callback only depends on `provider`, so the identity stays stable
  // for the life of a provider session.
  const reprobeCurrentProvider = useCallback(() => {
    void runProbe(provider);
  }, [runProbe, provider]);

  const updateState = useUpdateState();

  // Built once and rendered by whichever branch below wins — first-run setup
  // and the workshop are separate returns, and an installable update is worth
  // showing on both.
  const banner = <UpdateBanner state={updateState} platform={platform} />;

  // Hold the loading splash until the verdict has actually settled — never
  // guess first-run-vs-workshop while config is still loading or the probe is
  // mid-flight. This is what keeps "First run setup" from flashing past on a
  // slow cold boot before the probe confirms a model is already installed.
  if (!config || configured === null) {
    // Nothing first-run-flavoured renders here — not the intro, not the
    // "What is gezel?" Handboek article, not the banner. On a configured
    // install this branch lives for a few hundred milliseconds before
    // HomeWorkshop takes over, and anything with visual weight in it reads
    // as a flash of the wrong screen. The banner has a second reason:
    // handing the same element to a different parent a moment later tears
    // the node down and rebuilds it, so it visibly flickers and a click
    // landing in that window hits a detached button. Both are rendered by
    // the settled branches below as soon as there is a screen worth putting
    // them on. The placeholder itself fades in only after a delay (see
    // .home-loading-placeholder) so a fast boot shows an empty surface
    // rather than a spinner blink.
    return (
      <div className="home-view home-view-loading" aria-busy="true">
        <div className="home-loading-placeholder" aria-live="polite">
          <span className="home-loading-spinner" aria-hidden />
          <span>Loading…</span>
        </div>
      </div>
    );
  }

  // Once configured, the front door becomes the workshop — greeting band
  // and the meester conversation. The un-configured setup flow below is
  // preserved untouched.
  if (configured) {
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
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <div className="home-view">
      {banner}
      {/* ── First run setup ──────────────────────────────────────── */}
      {/* Setup leads, the intro follows. A first-run user's one job is to get a
          model onto the machine, so the download affordance owns the top of the
          screen; the "what is gezel?" pitch is reading material for after. */}
      {/* Everything below the intro is grouped + slightly indented so the
          steps read as one "First run setup" block. */}
      <h1 className="home-firstrun-heading">First run setup</h1>
      <p className="home-firstrun-lede muted">
        Use the buttons below to download local models from{' '}
        <a
          href="https://huggingface.co"
          target="_blank"
          rel="noreferrer"
          style={{ color: 'inherit' }}
        >
          Hugging Face
        </a>{' '}
        that will get you started.
      </p>
      <div className="home-firstrun-body">
        {/* First-run on-device install banner. Visible only while
          the bootstrapped default model is still downloading (or
          has failed). Hides itself once the model appears in the
          installed list. */}
        {config && (
          <FirstRunInstallBanner
            config={config}
            onConfigChanged={setConfig}
            onModelInstalled={reprobeCurrentProvider}
          />
        )}

        {/* One link into the full on-device chat-engine page — MLX on Mac,
          llama.cpp elsewhere — to browse other chat models. Cloud providers
          (Copilot, OpenAI, …) live in Settings too; first run is
          intentionally local-only. */}
        <section className="setup-section home-ondevice-link">
          <button
            type="button"
            className="gz-link-button"
            onClick={() => {
              const section =
                onDeviceProviderForPlatform(health?.platform) === 'mlx' ? 'mlx' : 'llamaCpp';
              requestSettingsSection(section);
              window.dispatchEvent(
                new CustomEvent('gezel:navigate', { detail: { view: 'settings', section } }),
              );
            }}
          >
            Manage Chat AI Models →
          </button>
          <p className="muted small" style={{ marginTop: '0.35rem', marginBottom: 0 }}>
            Browse other local models, or connect a cloud provider (GitHub Copilot, OpenAI, …), in
            Settings.
          </p>
        </section>

        {/* Optional local media models (image / speech / video) — recommended
          picks that fit this device, reviewed explicitly before download. */}
        <RecommendedMediaDownloads />

        {/* ── 2. Experience ────────────────────────────────────────── */}
        {/* "Boring mode" is one toggle over the two existing display flags:
          gezels show their role instead of a name (roleBasedNameOnlyMode)
          and their avatar/poppetje is hidden in favour of a plain letter
          tile (showPoppetjes=false). Dispatch config-updated so the live
          name/avatar hooks update everywhere without a reload. Either flag
          is still adjustable on its own in Settings. */}
        <section className="setup-section">
          <h3>Experience</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Tune how your gezellen present themselves. Adjustable any time in Settings.
          </p>
          <label className="debug-toggle">
            <input
              type="checkbox"
              checked={config?.roleBasedNameOnlyMode === true && config?.showPoppetjes === false}
              onChange={async (e) => {
                const boring = e.target.checked;
                try {
                  const res = await api.updateConfig({
                    roleBasedNameOnlyMode: boring,
                    showPoppetjes: !boring,
                  });
                  setConfig(res);
                  window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
                } catch {
                  /* non-fatal — adjustable later in Settings */
                }
              }}
            />
            <span>Boring mode — don't use names or show avatars</span>
          </label>
        </section>

        {/* ── 3. Security level ────────────────────────────────────── */}
        {/* Persists immediately; adjustable later in Settings → Security &
          Compliance. Super Lockdown keeps everything local-only. */}
        <SecurityLevelSection
          level={config?.securityPolicy?.level}
          onChange={async (next) => {
            try {
              const res = await api.updateConfig({ securityPolicy: securityPolicyForLevel(next) });
              setConfig(res);
            } catch {
              /* non-fatal — the user can set this later in Settings */
            }
          }}
        />
      </div>

      {/* ── Intro ────────────────────────────────────────────────── */}
      <IntroSection
        collapsed={collapseIntro ?? false}
        onToggle={() => setCollapseIntro((c) => !(c ?? false))}
        version={health?.version}
        meesterName={meesterDisplayName}
        isConfigured={false}
        provider={provider}
        defaultModel={effectiveDefaultModel}
        llamaCppBackend={health?.llamaCppBackend}
        llamaCppDetectedVendor={health?.llamaCppDetectedVendor}
      />
    </div>
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
 * elsewhere it defers to electron-updater's own elevating handoff.
 */
function UpdateBanner({ state, platform }: { state: UpdateState | null; platform?: string }) {
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  if (!state || state.kind !== 'ready') return null;

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

// Security level (first-run)
//
// A friendly first-run framing of the Security & Compliance policy. Picks
// the overall posture before provider setup so a Super Lockdown choice
// keeps the next step local-only. Full per-capability control lives in
// Settings → Security & Compliance. The posture list + copy is shared with
// that tab via SECURITY_LEVEL_PRESETS so the descriptions never drift.

function SecurityLevelSection({
  level,
  onChange,
}: {
  level: SecurityPresetLevel | 'custom' | undefined;
  onChange: (next: SecurityPresetLevel) => void | Promise<void>;
}) {
  const active = SECURITY_LEVEL_PRESETS.find((l) => l.id === level);
  return (
    // The engagement-mode-<level> class carries the posture-semantic latch
    // colors (sealed green / open amber) — same treatment as Settings.
    <section className={`setup-section${level ? ` engagement-mode-${level}` : ''}`}>
      <h3>Security &amp; compliance</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        How much should gezellen be allowed to do? Pick a starting posture — you can fine-tune every
        capability later in Settings → Security &amp; Compliance.
      </p>
      <div
        className="engagement-mode-switch gz-tray"
        role="radiogroup"
        aria-label="Security posture"
      >
        {SECURITY_LEVEL_PRESETS.map((l) => (
          <button
            key={l.id}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={level === l.id}
            className={`gz-key${level === l.id ? ' gz-key-active' : ''}`}
            onClick={() => void onChange(l.id)}
          >
            {l.label}
            {l.recommended ? ' ★' : ''}
          </button>
        ))}
      </div>
      <p className="engagement-mode-description" aria-live="polite">
        {active
          ? active.description
          : 'No level chosen yet — Lockdown (★) is a good default for most people.'}
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// Intro section
// ─────────────────────────────────────────────────────────────────

function IntroSection({
  collapsed,
  onToggle,
  version,
  meesterName,
  isConfigured,
  provider,
  defaultModel,
  llamaCppBackend,
  llamaCppDetectedVendor,
}: {
  collapsed: boolean;
  onToggle: () => void;
  version?: string;
  meesterName?: string;
  isConfigured: boolean;
  provider: Provider;
  defaultModel?: string;
  llamaCppBackend?: 'cuda' | 'vulkan' | 'metal' | 'cpu';
  llamaCppDetectedVendor?: 'amd' | 'nvidia' | 'intel';
}) {
  if (collapsed) {
    const providerSuffix = ` ${describeRunningEngine(provider, defaultModel, llamaCppBackend, llamaCppDetectedVendor)}`;
    return (
      <section className="home-intro home-intro-compact">
        <span>
          Welcome back{version ? ` — gezel v${version}` : ''}
          {providerSuffix}
        </span>
        <button
          type="button"
          className="home-intro-toggle"
          onClick={onToggle}
          aria-label="Expand intro"
          title="Expand intro"
        >
          <span aria-hidden>▾</span>
        </button>
      </section>
    );
  }
  return (
    // The download banner scrolls a waiting first-run user to this section.
    <section className="home-intro" id={FIRST_RUN_INTRO_ANCHOR_ID}>
      <div className="home-intro-body">
        <header>
          <h2>
            <img src={gezelLogotypeUrl} alt="gezel" className="home-intro-logotype" />
          </h2>
          <button
            type="button"
            className="home-intro-toggle"
            onClick={onToggle}
            aria-label="Collapse intro"
            title="Collapse intro"
          >
            <span aria-hidden>▴</span>
          </button>
        </header>
        {/* The intro copy lives in the Handboek's "What is gezel?" article
            (docs/handboek/conceptual/welcome.md) — embedded here as a live
            page so the first-run pitch and the documentation never drift. */}
        <IntroHandboekArticle />
        {isConfigured ? (
          <p>
            Get started with <strong>{meesterName ?? 'your Meester'}</strong>, your meester, who
            acts as your concierge. You can work with{' '}
            <strong>{meesterName ?? 'your Meester'}</strong> to create a project and a crew to solve
            any productivity need you have.
          </p>
        ) : (
          <>
            <p>
              To get started, download the recommended <strong>on-device</strong> model above — it
              runs privately on your machine, with no account or network required.
            </p>
            <p className="muted small">
              <strong>Note:</strong> Gezel is still in very early preview. On-device models are
              humbler than cloud AI, but they're the easiest way to get a feel for Gezel. Want a
              different local model, or a cloud provider like GitHub Copilot or OpenAI? Manage them
              from the on-device engine page and Settings.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Build the "using …" line shown under "Welcome back". Local engines
 * (llama.cpp, MLX) say *what* is running and on what hardware ("using
 * Nvidia GPU with qwen3.5-9b") so users see whether the GPU path is
 * actually engaged. Cloud providers stay with their existing
 * "using <provider> [<model>] by default" — there's no hardware to
 * surface there.
 */
function describeRunningEngine(
  provider: Provider,
  model: string | undefined,
  llamaCppBackend: 'cuda' | 'vulkan' | 'metal' | 'cpu' | undefined,
  llamaCppDetectedVendor: 'amd' | 'nvidia' | 'intel' | undefined,
): string {
  if (provider === 'llama-cpp') {
    const backendLabel = llamaCppBackendLabel(llamaCppBackend, llamaCppDetectedVendor);
    return model ? `using ${backendLabel} with ${model}` : `using ${backendLabel}`;
  }
  if (provider === 'mlx') {
    return model ? `using MLX with ${model}` : 'using MLX';
  }
  return model
    ? `using ${providerLabel(provider)} ${model} by default`
    : `using ${providerLabel(provider)} by default`;
}

function llamaCppBackendLabel(
  b: 'cuda' | 'vulkan' | 'metal' | 'cpu' | undefined,
  vendor: 'amd' | 'nvidia' | 'intel' | undefined,
): string {
  if (b === 'cuda') return 'Nvidia GPU';
  if (b === 'metal') return 'Apple GPU';
  if (b === 'cpu') return 'CPU';
  if (b === 'vulkan') {
    // Vulkan covers any GPU vendor — disambiguate when we can. AMD is
    // the case that motivated this: a Radeon user reading just "GPU"
    // can't tell whether their card is being used or whether they're
    // on an Intel iGPU. NVIDIA-via-Vulkan is rare (CUDA wins the
    // probe) but we label it for the few configurations where Vulkan
    // got picked anyway.
    if (vendor === 'amd') return 'AMD GPU';
    if (vendor === 'intel') return 'Intel GPU';
    if (vendor === 'nvidia') return 'Nvidia GPU';
    return 'GPU';
  }
  // Backend unknown — supervisor didn't set GEZEL_LLAMA_SERVER_BACKEND
  // (e.g. running in a non-Electron context). Fall back to the prior
  // generic label so the line still reads naturally.
  return 'On-device';
}

function providerLabel(p: Provider): string {
  switch (p) {
    case 'copilot':
      return 'GitHub Copilot';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic Claude';
    case 'anthropic-cli':
      return 'Anthropic Claude CLI';
    case 'codex-cli':
      return 'OpenAI Codex CLI';
    case 'ollama':
      return 'Ollama';
    case 'llama-cpp':
      return 'On-device';
    case 'mlx':
      return 'MLX';
    case 'ds4':
      return 'DwarfStar (ds4)';
    case 'remote':
      return 'Remote';
  }
}
