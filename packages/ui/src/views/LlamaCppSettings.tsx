import type { HealthResponse, LlamaCppContextSizing } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import type { LlamaCppInstalledModel } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { EngineBudgetStrip } from '../components/EngineBudgetStrip.js';
import { EngineClonePicker } from '../components/EngineClonePicker.js';
import { LlamaCppModelManager } from '../components/LlamaCppModelManager.js';
import { MachineHealthSettings } from '../components/MachineHealthSettings.js';

interface Props {
  config: ConfigResponse | null;
  onConfigChanged: (cfg: ConfigResponse) => void;
  /** From `/api/health` — the supervisor's currently-resolved backend
   *  variant. Drives the "Auto (currently: cuda)" hint next to the
   *  override picker so users can see which physical backend the
   *  auto-detect picked. May be undefined when the supervisor hasn't
   *  populated GEZEL_LLAMA_SERVER_BACKEND (e.g. CLI launches). */
  health?: HealthResponse | null;
}

type BackendOverride = NonNullable<ConfigResponse['llamaCppBackendOverride']>;
type ConcreteBackend = Exclude<BackendOverride, 'auto'>;
type KvCacheType = NonNullable<ConfigResponse['llamaCppKvCacheType']>;
type SpecType = NonNullable<ConfigResponse['llamaCppSpecType']>;
type FlashAttnMode = 'auto' | 'on' | 'off';
type TriState = 'auto' | 'on' | 'off';

/** Map a nullable boolean config override to the tri-state select value. */
function triStateValue(v: boolean | null | undefined): TriState {
  if (v === true) return 'on';
  if (v === false) return 'off';
  return 'auto';
}

/**
 * Backends the dropdown should offer for this machine, given:
 *   - the platform (Mac vs Windows/Linux), and
 *   - what the **hardware probe** found, NOT what the user has pinned.
 *     The probe value comes from `health.llamaCppDetectedBackend`
 *     (independent of any override). Using the override-applied value
 *     here would lock a CPU-pinned user out of CUDA/Vulkan options on
 *     a CUDA machine — the very situation that motivated this split.
 *
 * Only "downgrade" options are shown — picking something faster than
 * what the probe found would just hard-fail at boot. The dropdown's
 * "Auto-detect" entry is rendered separately by the caller; this
 * helper returns only the concrete-backend options.
 *
 *   Mac:           Metal only (Mac doesn't ship CUDA/Vulkan variants).
 *   Win/Linux+CUDA: CUDA / Vulkan / CPU (probe found CUDA → either downgrade is valid).
 *   Win/Linux+Vulkan: Vulkan / CPU (no CUDA driver → can only downgrade to CPU).
 *   Win/Linux+CPU:  CPU only (no GPU drivers — nothing to downgrade from).
 *   Unknown probe:  show all PC options as a defensive default so the
 *                   user can still pin something if the supervisor
 *                   didn't populate the env var (e.g. CLI launches).
 */
function availableBackendOptions(
  platform: string | undefined,
  detected: 'cuda' | 'vulkan' | 'metal' | 'cpu' | undefined,
): ConcreteBackend[] {
  if (platform === 'darwin') return ['metal'];
  if (detected === 'cuda') return ['cuda', 'vulkan', 'cpu'];
  if (detected === 'vulkan') return ['vulkan', 'cpu'];
  if (detected === 'cpu') return ['cpu'];
  // Unknown / supervisor didn't populate — fall through to the full
  // PC set so the user isn't stuck.
  return ['cuda', 'vulkan', 'cpu'];
}

function backendOptionLabel(b: ConcreteBackend): string {
  if (b === 'cuda') return 'CUDA (Nvidia GPU)';
  if (b === 'vulkan') return 'Vulkan (any GPU)';
  if (b === 'metal') return 'Metal (Apple GPU)';
  return 'CPU only';
}

/**
 * Render the vendor portion of the auto-detect hint, e.g. "
 *   (machine supports: vulkan, AMD GPU detected)"
 * vs the bare "machine supports: vulkan" when the vendor is unknown.
 * Empty string when no vendor info is available so the parent line
 * just reads "machine supports: <backend>".
 */
function vendorSuffix(v: 'amd' | 'nvidia' | 'intel' | undefined): string {
  if (v === 'amd') return ', AMD GPU detected';
  if (v === 'nvidia') return ', Nvidia GPU detected';
  if (v === 'intel') return ', Intel GPU detected';
  return '';
}

/**
 * The supervisor sets `GEZEL_LLAMA_SERVER_BACKEND` once at process
 * start and never re-probes — config-change → env-var update only
 * happens on the next launch. We compare the user's current dropdown
 * intent against what's actually running and prompt for a restart on
 * any divergence.
 *
 * Crucially this fires for the **auto ← override** transition too, not
 * just override ← auto. The previous version only nudged when an
 * override was set, which left users who clicked "Auto-detect" to back
 * out of a pinned `cpu` thinking nothing happened (the supervisor's
 * env var was still `cpu` until restart).
 */
function needsRestart(
  config: ConfigResponse | null,
  health: HealthResponse | null | undefined,
): boolean {
  if (!health?.llamaCppBackend) return false; // no signal yet, don't nag
  const currentlyRunning = health.llamaCppBackend;
  // What WOULD run if we restarted right now: the override if pinned,
  // otherwise whatever the hardware probe found.
  const wouldRun =
    config?.llamaCppBackendOverride && config.llamaCppBackendOverride !== 'auto'
      ? config.llamaCppBackendOverride
      : (health.llamaCppDetectedBackend ?? currentlyRunning);
  // A quarantined backend is detected but unusable, so it is NOT what
  // would run — resolution routes around it every launch. Without this,
  // a machine whose CUDA build crashes reads as permanently
  // "needs restart": detected=cuda, running=vulkan, restart changes
  // nothing, and the prompt never goes away. The quarantine gets its own
  // notice (system-notices.ts) that explains the real situation.
  if (health.llamaCppQuarantinedBackends?.includes(wouldRun)) return false;
  return wouldRun !== currentlyRunning;
}

/**
 * Dedicated tab for llama.cpp — mirrors OllamaSettings in
 * structure but the knob set is much smaller: most of the
 * complexity Ollama surfaces (num_ctx, three separate timeouts,
 * think mode) doesn't apply here. The main event is the model
 * install/list/delete manager; the advanced section lets users
 * override the auto-detected supervisor with an external
 * llama-server URL for dev / LAN scenarios.
 */
export function LlamaCppSettings({ config, onConfigChanged, health }: Props) {
  const [baseUrlDraft, setBaseUrlDraft] = useState(config?.llamaCppBaseUrl ?? '');
  const [modelPathDraft, setModelPathDraft] = useState(config?.llamaCppModelPath ?? '');
  const [installed, setInstalled] = useState<LlamaCppInstalledModel[]>([]);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [contextSizing, setContextSizing] = useState<LlamaCppContextSizing>('adaptive');
  const [contextSizingLoading, setContextSizingLoading] = useState(true);

  useEffect(() => {
    setBaseUrlDraft(config?.llamaCppBaseUrl ?? '');
  }, [config?.llamaCppBaseUrl]);
  useEffect(() => {
    setModelPathDraft(config?.llamaCppModelPath ?? '');
  }, [config?.llamaCppModelPath]);

  const refreshInstalled = useCallback(async () => {
    try {
      const res = await api.listLlamaCppModels();
      setInstalled(res.models);
    } catch {
      /* ignore — the model-manager panel below surfaces its own errors */
    }
  }, []);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getLlamaCppContextSizing()
      .then((response) => {
        if (!cancelled) setContextSizing(response.policy);
      })
      .catch(() => {
        /* Keep the safe/default Adaptive choice when the engine is unavailable. */
      })
      .finally(() => {
        if (!cancelled) setContextSizingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveBaseUrl = useCallback(async () => {
    const trimmed = baseUrlDraft.trim();
    setSaving('saving');
    try {
      const next = await api.updateConfig({
        llamaCppBaseUrl: trimmed === '' ? null : trimmed,
      });
      onConfigChanged(next);
      setSaving('saved');
      setTimeout(() => setSaving('idle'), 1200);
    } catch {
      setSaving('idle');
    }
  }, [baseUrlDraft, onConfigChanged]);

  const saveBackendOverride = useCallback(
    async (value: BackendOverride) => {
      setSaving('saving');
      try {
        const next = await api.updateConfig({
          // 'auto' clears the override (returns to auto-detect). Send null,
          // not undefined: undefined is stripped by JSON.stringify and the
          // store only clears a field on explicit null.
          llamaCppBackendOverride: value === 'auto' ? null : value,
        });
        onConfigChanged(next);
        setSaving('saved');
        setTimeout(() => setSaving('idle'), 1200);
      } catch {
        setSaving('idle');
      }
    },
    [onConfigChanged],
  );

  const saveContextSizing = useCallback(async (policy: LlamaCppContextSizing) => {
    setSaving('saving');
    try {
      const updated = await api.updateLlamaCppContextSizing(policy);
      setContextSizing(updated.policy);
      setSaving('saved');
      setTimeout(() => setSaving('idle'), 1200);
    } catch {
      setSaving('idle');
    }
  }, []);

  const saveModelPath = useCallback(async () => {
    const trimmed = modelPathDraft.trim();
    setSaving('saving');
    try {
      const next = await api.updateConfig({
        llamaCppModelPath: trimmed === '' ? null : trimmed,
      });
      onConfigChanged(next);
      setSaving('saved');
      setTimeout(() => setSaving('idle'), 1200);
    } catch {
      setSaving('idle');
    }
  }, [modelPathDraft, onConfigChanged]);

  const saveKvCacheType = useCallback(
    async (value: KvCacheType) => {
      setSaving('saving');
      try {
        const next = await api.updateConfig({
          // q8_0 is the default — clear the override when it's selected so
          // we don't pin a value that just tracks the default. Send null,
          // not undefined: undefined is stripped by JSON.stringify and the
          // store only clears a field on explicit null.
          llamaCppKvCacheType: value === 'q8_0' ? null : value,
        });
        onConfigChanged(next);
        setSaving('saved');
        setTimeout(() => setSaving('idle'), 1200);
      } catch {
        setSaving('idle');
      }
    },
    [onConfigChanged],
  );

  const saveFlashAttn = useCallback(
    async (value: FlashAttnMode) => {
      setSaving('saving');
      try {
        const next = await api.updateConfig({
          // 'auto' is the server default — clear the override so we don't
          // pin a value that just tracks the default. Send null, not
          // undefined (see saveKvCacheType).
          llamaCppFlashAttn: value === 'auto' ? null : value,
        });
        onConfigChanged(next);
        setSaving('saved');
        setTimeout(() => setSaving('idle'), 1200);
      } catch {
        setSaving('idle');
      }
    },
    [onConfigChanged],
  );

  const saveCpuMoe = useCallback(
    async (value: TriState) => {
      setSaving('saving');
      try {
        // Auto (null) clears the override → the launch-time offload planner
        // decides. On (true) forces --cpu-moe; Off (false) forces experts
        // onto the GPU and suppresses the planner's partial offload too.
        const next = await api.updateConfig({
          llamaCppCpuMoe: value === 'auto' ? null : value === 'on',
        });
        onConfigChanged(next);
        setSaving('saved');
        setTimeout(() => setSaving('idle'), 1200);
      } catch {
        setSaving('idle');
      }
    },
    [onConfigChanged],
  );

  const saveSwaFull = useCallback(
    async (value: TriState) => {
      setSaving('saving');
      try {
        // Auto (null) clears the override → on for the Gemma family, off
        // otherwise. On/Off force the flag regardless of architecture.
        const next = await api.updateConfig({
          llamaCppSwaFull: value === 'auto' ? null : value === 'on',
        });
        onConfigChanged(next);
        setSaving('saved');
        setTimeout(() => setSaving('idle'), 1200);
      } catch {
        setSaving('idle');
      }
    },
    [onConfigChanged],
  );

  const saveSpecType = useCallback(
    async (value: SpecType | 'none') => {
      setSaving('saving');
      try {
        const next = await api.updateConfig({
          // Unset is the persisted off/default state. Catalog MTP capability
          // metadata never activates speculative decoding by itself. Send
          // null, not undefined (see saveKvCacheType).
          llamaCppSpecType: value === 'none' ? null : value,
        });
        onConfigChanged(next);
        setSaving('saved');
        setTimeout(() => setSaving('idle'), 1200);
      } catch {
        setSaving('idle');
      }
    },
    [onConfigChanged],
  );

  const saveDefaultModel = useCallback(
    async (value: string | undefined) => {
      setSaving('saving');
      try {
        const next = await api.updateConfig({
          defaultModel: {
            ...config?.defaultModel,
            'llama-cpp': value ?? undefined,
          },
        });
        onConfigChanged(next);
        setSaving('saved');
        setTimeout(() => setSaving('idle'), 1200);
      } catch {
        setSaving('idle');
      }
    },
    [config?.defaultModel, onConfigChanged],
  );

  const currentDefault = config?.defaultModel?.['llama-cpp'];
  const hasExternalBaseUrl = Boolean(config?.llamaCppBaseUrl);

  return (
    <div>
      <section style={{ marginBottom: '2rem' }}>
        <h3>On-device</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Run AI models directly on this device, making the best use of the hardware you already
          have. Your conversations stay on your computer — no account to set up, no data sent to the
          cloud.
        </p>

        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <span className="muted small">Status:</span>
          <span className="home-status-pill home-status-ok">ready</span>
          {hasExternalBaseUrl && (
            <span
              className="home-status-pill home-status-warn"
              title={`Using an external engine at: ${config?.llamaCppBaseUrl}`}
            >
              using external engine
            </span>
          )}
          {saving === 'saved' && <span className="muted small">saved ✓</span>}
        </div>
      </section>

      {installed.length > 1 && (
        <section style={{ marginBottom: '2rem' }}>
          <h4>Default model</h4>
          <p className="muted small" style={{ marginTop: 0 }}>
            Which local model new chat sessions use when a gezel doesn't pin one.
          </p>
          <div className="new-row" style={{ marginTop: '0.5rem' }}>
            <select
              value={currentDefault ?? ''}
              onChange={(e) => void saveDefaultModel(e.target.value || undefined)}
            >
              <option value="">First local model</option>
              {installed.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.id})
                </option>
              ))}
            </select>
          </div>
        </section>
      )}

      <section style={{ marginBottom: '2rem' }}>
        <h4>Models</h4>
        <LlamaCppModelManager key={contextSizing} onModelsChanged={refreshInstalled} />
      </section>

      <EngineBudgetStrip provider="llama-cpp" />

      <section style={{ marginBottom: '2rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>Concurrent replicas</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Run multiple copies of the same model so unrelated sessions don't queue behind each other.
          Weights are shared by the OS via mmap so disk cost stays at one model file; resident
          memory grows because each clone keeps its own KV cache and activations.
        </p>
        <EngineClonePicker
          provider="llama-cpp"
          modelId={config?.defaultModel?.['llama-cpp'] ?? null}
          config={config}
          onConfigChanged={onConfigChanged}
        />
      </section>

      <MachineHealthSettings
        config={config}
        onConfigChanged={onConfigChanged}
        platform={window.__GEZEL__?.platform ?? health?.platform}
      />

      <details className="llama-advanced-settings">
        <summary className="llama-advanced-summary">
          <span className="llama-advanced-caret" aria-hidden="true">
            &rsaquo;
          </span>
          <h4>Advanced</h4>
        </summary>
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          Tune how the managed on-device engine starts, or override how Gezel connects to it. Most
          users don't need any of these — the supervised engine handles everything. Set them only
          when you need a different context policy, are running your own engine process, point at a
          weights file that isn't in the catalog, or downgrade the accelerator.
        </p>

        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label
            htmlFor="llama-cpp-context-sizing"
            className="muted"
            style={{ fontSize: '0.9rem', minWidth: '10rem' }}
          >
            Context sizing
          </label>
          <select
            id="llama-cpp-context-sizing"
            value={contextSizing}
            disabled={contextSizingLoading || saving === 'saving' || hasExternalBaseUrl}
            onChange={(e) => void saveContextSizing(e.target.value as LlamaCppContextSizing)}
            style={{ flex: 1, maxWidth: '20rem' }}
          >
            <option value="adaptive">Adaptive (recommended)</option>
            <option value="model-max">Model maximum (strict)</option>
          </select>
        </div>
        <p className="muted small" style={{ marginTop: '0.25rem', marginLeft: '10rem' }}>
          <em>Adaptive</em> uses model tuning (64K by default), reducing concurrency before it
          shortens a larger tuned window. <em>Model maximum</em> requests the model's full
          advertised window; if one engine slot cannot hold it safely, the model will not start.
          This is a machine-wide managed-engine setting. Changing it restarts idle local engines
          right away; a model that is mid-conversation finishes its current turn first.
          {hasExternalBaseUrl ? ' External engine URLs manage their own context size.' : ''}
        </p>

        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label
            htmlFor="llama-cpp-engine-backend"
            className="muted"
            style={{ fontSize: '0.9rem', minWidth: '10rem' }}
          >
            Engine backend
          </label>
          <select
            id="llama-cpp-engine-backend"
            value={config?.llamaCppBackendOverride ?? 'auto'}
            onChange={(e) => void saveBackendOverride(e.target.value as BackendOverride)}
            style={{ flex: 1, maxWidth: '20rem' }}
          >
            <option value="auto">
              Auto-detect
              {health?.llamaCppDetectedBackend
                ? ` (machine supports: ${health.llamaCppDetectedBackend}${vendorSuffix(health.llamaCppDetectedVendor)})`
                : ''}
            </option>
            {availableBackendOptions(health?.platform, health?.llamaCppDetectedBackend).map((b) => (
              <option key={b} value={b}>
                {backendOptionLabel(b)}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {needsRestart(config, health) ? 'Restart the app to apply' : ''}
          </span>
        </div>
        <p className="muted small" style={{ marginTop: '0.25rem', marginLeft: '10rem' }}>
          Auto-detect picks the fastest backend your machine supports; the other options are
          downgrades you can pin if the faster path is misbehaving. Switching <em>back</em> to
          Auto-detect from a pinned override also requires a restart.
        </p>

        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: '0.9rem', minWidth: '10rem' }}>
            KV cache quantization
          </label>
          <select
            value={config?.llamaCppKvCacheType ?? 'q8_0'}
            onChange={(e) => void saveKvCacheType(e.target.value as KvCacheType)}
            style={{ flex: 1, maxWidth: '20rem' }}
          >
            <option value="f16">f16 — full precision (most memory)</option>
            <option value="q8_0">q8_0 — balanced (default)</option>
            <option value="q4_0">q4_0 — smallest (most savings)</option>
          </select>
        </div>
        <p className="muted small" style={{ marginTop: '0.25rem', marginLeft: '10rem' }}>
          Sets <code>--cache-type-k</code> / <code>--cache-type-v</code> for llama-server.
          Quantizing the KV cache frees RAM for longer contexts and more concurrent sessions: q8_0
          is near-lossless at ~50% savings vs. f16, while q4_0 saves the most but can dent quality
          on attention-sensitive models. Takes effect the next time the engine starts — restart the
          app to apply now.
        </p>

        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: '0.9rem', minWidth: '10rem' }}>
            Flash attention
          </label>
          <select
            value={
              typeof config?.llamaCppFlashAttn === 'string'
                ? config.llamaCppFlashAttn
                : config?.llamaCppFlashAttn === true
                  ? 'on'
                  : 'auto'
            }
            onChange={(e) => void saveFlashAttn(e.target.value as FlashAttnMode)}
            style={{ flex: 1, maxWidth: '20rem' }}
          >
            <option value="auto">Auto (recommended)</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </div>
        <p className="muted small" style={{ marginTop: '0.25rem', marginLeft: '10rem' }}>
          Faster attention on modern GPUs, and effectively required for the fast path under a
          quantized KV cache (the default). Auto lets llama-server decide; the engine forces it on
          when the KV cache is quantized. Takes effect the next time the engine starts.
        </p>

        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: '0.9rem', minWidth: '10rem' }}>
            Speculative decoding
          </label>
          <select
            value={config?.llamaCppSpecType ?? 'none'}
            onChange={(e) => void saveSpecType(e.target.value as SpecType | 'none')}
            style={{ flex: 1, maxWidth: '20rem' }}
          >
            <option value="none">Off</option>
            <option value="ngram-mod">N-gram lookup (no draft model)</option>
            <option value="draft-mtp">Model MTP head (experimental)</option>
          </select>
        </div>
        <p className="muted small" style={{ marginTop: '0.25rem', marginLeft: '10rem' }}>
          Drafts several tokens per step and verifies them against the target model. <em>N-gram</em>{' '}
          needs no extra model and helps most on repetitive or structured output. <em>MTP</em> uses
          the model's own prediction head, requires compatible downloaded weights, and may change
          behavior on experimental engine/model combinations. Takes effect the next time the engine
          starts.
        </p>

        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: '0.9rem', minWidth: '10rem' }}>
            MoE expert offload
          </label>
          <select
            value={triStateValue(config?.llamaCppCpuMoe)}
            onChange={(e) => void saveCpuMoe(e.target.value as TriState)}
            style={{ flex: 1, maxWidth: '20rem' }}
          >
            <option value="auto">Auto — detect when offload is needed (default)</option>
            <option value="on">On — always offload experts (--cpu-moe)</option>
            <option value="off">Off — keep experts on the GPU</option>
          </select>
        </div>
        <p className="muted small" style={{ marginTop: '0.25rem', marginLeft: '10rem' }}>
          For big Mixture-of-Experts models on a small GPU: run attention on the GPU while streaming
          the sparse expert weights from system RAM — lets a model that wouldn't fit in VRAM run
          anyway. <em>Auto</em> turns this on only for a MoE model that won't fit in VRAM (and sizes
          a partial split when it can), and leaves dense models and UMA machines alone. Takes effect
          the next time the engine starts.
        </p>
        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: '0.9rem', minWidth: '10rem' }}>
            Full SWA cache
          </label>
          <select
            value={triStateValue(config?.llamaCppSwaFull)}
            onChange={(e) => void saveSwaFull(e.target.value as TriState)}
            style={{ flex: 1, maxWidth: '20rem' }}
          >
            <option value="auto">Auto — full only when it fits fast memory</option>
            <option value="on">On — always full cache (--swa-full)</option>
            <option value="off">Off — memory-efficient windowed cache</option>
          </select>
        </div>
        <p className="muted small" style={{ marginTop: '0.25rem', marginLeft: '10rem' }}>
          For sliding-window models (the Gemma family): retain old KV entries that the
          memory-efficient windowed cache normally discards. This can enable prompt reuse and other
          cache operations where the engine supports them, but its memory cost grows with context.{' '}
          <em>Auto</em> uses the full cache only when the model weights and full KV cache fit in
          fast memory — VRAM on a discrete GPU — and otherwise keeps the windowed cache. Takes
          effect the next time the engine starts.
        </p>
        <p className="muted small" style={{ marginTop: '0.5rem', marginLeft: '10rem' }}>
          More engine flags (an explicit GPU-layer count, partial expert split, prompt-reuse size,
          threads, and a raw-flag escape hatch) live in <code>config.json</code> under the{' '}
          <code>llamaCpp*</code> keys.
        </p>

        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: '0.9rem', minWidth: '10rem' }}>
            External engine URL
          </label>
          <input
            type="text"
            placeholder="e.g. http://127.0.0.1:8080  (leave blank to use the supervised engine)"
            value={baseUrlDraft}
            onChange={(e) => setBaseUrlDraft(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            disabled={saving === 'saving' || baseUrlDraft === (config?.llamaCppBaseUrl ?? '')}
            onClick={() => void saveBaseUrl()}
          >
            Save
          </button>
        </div>

        <div className="new-row" style={{ marginTop: '0.5rem', alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: '0.9rem', minWidth: '10rem' }}>
            Override model path
          </label>
          <input
            type="text"
            placeholder="Absolute path to a .gguf file (overrides the local-models default)"
            value={modelPathDraft}
            onChange={(e) => setModelPathDraft(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            disabled={saving === 'saving' || modelPathDraft === (config?.llamaCppModelPath ?? '')}
            onClick={() => void saveModelPath()}
          >
            Save
          </button>
        </div>

        <EngineLogViewer />
      </details>
    </div>
  );
}

/**
 * Tail the supervised llama-server's rolling log. Snapshot-only —
 * refresh button fetches the last ~4KB again. Useful for support
 * tickets ("what did the engine say when it died?") and for
 * developers iterating on the native binary. The log captures raw
 * stdout/stderr, so it's technical by design; copy reads that way.
 */
function EngineLogViewer() {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'loaded'; path: string | null; tail: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await api.getLlamaCppLog(4096);
      setState({ kind: 'loaded', path: res.path, tail: res.tail });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return (
    <details style={{ marginTop: '1rem' }}>
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
        Engine log{' '}
        <span className="muted small">
          — technical output from llama-server. Useful for bug reports.
        </span>
      </summary>
      <div style={{ marginTop: '0.5rem' }}>
        <div className="new-row" style={{ alignItems: 'center', gap: '0.5rem' }}>
          <button type="button" onClick={() => void load()} disabled={state.kind === 'loading'}>
            {state.kind === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
          {state.kind === 'loaded' && state.path && (
            <span className="muted small" title={state.path}>
              {state.path}
            </span>
          )}
          {state.kind === 'loaded' && !state.path && (
            <span className="muted small">No supervised engine running.</span>
          )}
        </div>
        {state.kind === 'error' && (
          <div className="muted small" style={{ marginTop: '0.5rem', color: '#ff9b9b' }}>
            Couldn't load log: {state.message}
          </div>
        )}
        {state.kind === 'loaded' && state.tail && (
          <pre
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 4,
              maxHeight: '18rem',
              overflow: 'auto',
              fontSize: '0.75rem',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {state.tail}
          </pre>
        )}
        {state.kind === 'loaded' && !state.tail && state.path && (
          <div className="muted small" style={{ marginTop: '0.5rem' }}>
            Log is empty. (Engine may not have started yet — try chatting with an on-device gezel
            first.)
          </div>
        )}
      </div>
    </details>
  );
}
