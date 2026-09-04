import type { HealthResponse, Project, SecurityPresetLevel } from '@bendyline/gezel';
import {
  DEFAULT_SECURITY_LEVEL,
  displayName,
  isLocalProvider,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import type { ProviderName } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateState } from '../api.js';
import { api } from '../api.js';
import { FirstRunInstallBanner } from '../components/FirstRunInstallBanner.js';
import { RecommendedMediaDownloads } from '../components/RecommendedMediaDownloads.js';
import { useRoleBasedNameOnlyMode } from '../components/useRoleBasedNameOnlyMode.js';
import { releaseUrl } from '../github-urls.js';
import { UI_FALLBACK_PROVIDER } from '../provider-default.js';
import { SECURITY_LEVEL_PRESETS } from '../security-levels.js';
import { requestSettingsSection } from '../settings-nav.js';
import { useUpdateState } from '../update-state.js';
import '../styles/home-view.css';
import { Poppetje } from '../poppetje/index.js';
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
 * The first screen a user sees. Two states:
 *   - First run (unconfigured): setup in the left column — the one
 *     required model download, quiet optional links, security posture,
 *     preferences — with the "What is gezel?" tutorial (player + article)
 *     riding in a second column beside it.
 *   - Configured: the Meester workshop (HomeWorkshop) takes the surface.
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
      {/* Setup leads; the "what is gezel?" tutorial rides in a second column
          beside it when the window is wide enough (stacking beneath on
          narrow windows), so the pitch is readable while the model
          downloads without ever pushing setup below the fold. */}
      <div className="home-firstrun-columns">
        <div className="home-firstrun-main">
          <h1 className="home-firstrun-heading">First run setup</h1>
          <p className="home-firstrun-lede muted">
            Gezel chats through a local AI model that runs privately on this device — download the
            recommended one to get started.
          </p>
          <div className="home-firstrun-body">
            {/* First-run on-device install banner — the page's ONE primary action.
          Visible only while the bootstrapped default model is still
          downloading (or has failed). Hides itself once the model appears in
          the installed list. Everything after it is deliberately quiet links:
          the 2026-09-02 UX review found the old stack of terracotta media
          buttons out-shouting this required step. */}
            {config && (
              <FirstRunInstallBanner
                config={config}
                onConfigChanged={setConfig}
                onModelInstalled={reprobeCurrentProvider}
              />
            )}

            {/* Optional media sidecars — one desaturated link into a review
          dialog; recommended picks that fit this device. */}
            <RecommendedMediaDownloads />

            {/* The one Settings link: the full on-device chat-engine page — MLX
          on Mac, llama.cpp elsewhere. Cloud providers (Copilot, OpenAI, …)
          live in Settings too; first run is intentionally local-only. */}
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
                Manage AI models in Settings →
              </button>
              <p className="muted small" style={{ marginTop: '0.35rem', marginBottom: 0 }}>
                Browse other local models, or connect a cloud provider (GitHub Copilot, OpenAI, …).
              </p>
            </section>

            {/* ── 2. Security level ────────────────────────────────────── */}
            {/* Persists immediately; adjustable later in Settings → Security &
          Compliance. Super Lockdown keeps everything local-only. Ordered
          above the display toggle on purpose: this is the one first-run
          choice with real consequences (2026-09-02 UX review). */}
            <SecurityLevelSection
              level={config?.securityPolicy?.level}
              onChange={async (next) => {
                try {
                  const res = await api.updateConfig({
                    securityPolicy: securityPolicyForLevel(next),
                  });
                  setConfig(res);
                } catch {
                  /* non-fatal — the user can set this later in Settings */
                }
              }}
            />

            {/* ── 3. Preferences ───────────────────────────────────────── */}
            {/* One positive toggle over the two display flags: unchecking shows
          role-based names (roleBasedNameOnlyMode) and plain letter avatars
          (showPoppetjes=false). Same single-switch shape as Settings →
          General. Dispatch config-updated so the live name/avatar hooks
          update everywhere without a reload. The heading keeps the toggle
          from reading as part of Security & compliance above it. */}
            <section className="setup-section">
              <h3>Preferences</h3>
              {/* The example makes the toggle concrete before the user has
                  met anyone: the real meester's name in the label and their
                  actual poppetje beside it — the very things the switch
                  shows or hides. Raw meesterName on purpose (not the
                  role-based display name): the example must show what
                  turning the toggle ON looks like. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <label className="debug-toggle" style={{ marginTop: 0 }}>
                  <input
                    type="checkbox"
                    checked={
                      config?.roleBasedNameOnlyMode !== true && config?.showPoppetjes !== false
                    }
                    onChange={async (e) => {
                      const show = e.target.checked;
                      try {
                        const res = await api.updateConfig({
                          roleBasedNameOnlyMode: !show,
                          showPoppetjes: show,
                        });
                        setConfig(res);
                        window.dispatchEvent(
                          new CustomEvent('gezel:config-updated', { detail: res }),
                        );
                      } catch {
                        /* non-fatal — adjustable later in Settings */
                      }
                    }}
                  />
                  <span>
                    Show gezel names and poppetjes
                    {meesterName ? ` (e.g., ${meesterName}, your meester)` : ''}
                  </span>
                </label>
                {meesterPoppetje && (
                  <div
                    className="gezel-icon"
                    style={{ width: 36, height: 36 }}
                    title={meesterName ? `${meesterName}'s poppetje` : 'example poppetje'}
                  >
                    <div className="gezel-icon-poppetje">
                      <Poppetje poppetje={meesterPoppetje} variant="headshot" size={36} />
                    </div>
                  </div>
                )}
              </div>
              <p className="muted small" style={{ marginTop: '0.35rem', marginBottom: 0 }}>
                Adjustable any time in Settings.
              </p>
            </section>
          </div>
        </div>

        {/* ── Tutorial column ─────────────────────────────────────── */}
        {/* The "What is gezel?" article, stacked: the DocPlayer (watch view)
            on top and the readable page beneath, scrolling on its own
            beside setup. Keeps the download banner's "read what gezel is"
            scroll anchor. */}
        <aside
          className="home-firstrun-tutorial"
          id={FIRST_RUN_INTRO_ANCHOR_ID}
          aria-label="What is gezel?"
        >
          <IntroHandboekArticle variant="stacked" />
        </aside>
      </div>
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
  // An unset policy already behaves as Lockdown (resolveSecurityPolicy falls
  // back to DEFAULT_SECURITY_LEVEL), so show that key latched instead of a
  // "no level chosen yet" placeholder — the tray reflects what is actually
  // in force from the first paint.
  const effective = level ?? DEFAULT_SECURITY_LEVEL;
  const active = SECURITY_LEVEL_PRESETS.find((l) => l.id === effective);
  return (
    // The engagement-mode-<level> class carries the posture-semantic latch
    // colors (sealed green / open amber) — same treatment as Settings.
    <section className={`setup-section engagement-mode-${effective}`}>
      <h3>Security &amp; compliance</h3>
      <p className="muted" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
        How much should gezellen be allowed to do? Pick a starting posture — you can fine-tune every
        capability later in Settings → Security &amp; Compliance.
      </p>
      <div
        className="engagement-mode-switch gz-tray gz-tray--described"
        role="radiogroup"
        aria-label="Security posture"
      >
        {SECURITY_LEVEL_PRESETS.map((l) => (
          <button
            key={l.id}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={effective === l.id}
            className={`gz-key${effective === l.id ? ' gz-key-active' : ''}`}
            onClick={() => void onChange(l.id)}
          >
            {l.label}
            {l.recommended ? ' ★' : ''}
          </button>
        ))}
      </div>
      <p className="engagement-mode-description gz-tray-description" aria-live="polite">
        {active ? (
          <>
            <strong>{active.label}</strong> — {active.description}
          </>
        ) : (
          <>
            <strong>Custom</strong> — capability switches were adjusted individually. Fine-tune in
            Settings → Security &amp; Compliance.
          </>
        )}
      </p>
    </section>
  );
}
