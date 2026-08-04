import type { GezmodelEngine, ModelInfo, ProviderName } from '@bendyline/gezel';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  MODEL_INVENTORY_CHANGED_EVENT,
  changedModelInventoryEngine,
  modelInventoryRevision,
} from '../model-inventory.js';
import { Select } from '../primitives/index.js';
import { requestSettingsSection } from '../settings-nav.js';
import { detectDs4Availability } from '../views/ds4-availability.js';

/**
 * Combined provider + model picker. Replaces the old `Provider:` chip
 * row + separate `Model:` dropdown that lived next to it. The two
 * surfaces always changed together — picking "Copilot" and then a
 * specific model is one decision, not two — so collapsing them into a
 * single dropdown removes a bunch of clicks AND filters out the
 * shapes that don't make sense:
 *
 *   - Cloud providers without credentials → entry hidden entirely.
 *   - On-device runtime with no models downloaded → entry hidden.
 *   - Ollama with no models pulled → entry hidden.
 *
 * Each composite entry encodes both pieces as `<provider>:<modelId>`
 * so the parent saves them together in a single `updateGezelSettings`
 * call instead of racing two PUTs that briefly leave the gezel in a
 * "OpenAI provider, Ollama model" inconsistent state.
 *
 * Reasoning effort and font stay separate — they're orthogonal to the
 * provider/model pair and don't compose meaningfully into one menu.
 */

interface ProviderEntry {
  provider: ProviderName;
  /** Friendly label shown in the dropdown ("GitHub Copilot", "This Mac", …). */
  label: string;
  models: ModelInfo[];
  /** Set when the fetch failed — the entry is dropped from the list. */
  error?: string;
}

const COMPOSITE_INHERIT = '__INHERIT__';

function compositeValue(provider: ProviderName | null, model: string | undefined): string {
  if (!provider) return COMPOSITE_INHERIT;
  return `${provider}:${model ?? ''}`;
}

function parseComposite(
  value: string,
): { kind: 'inherit' } | { kind: 'override'; provider: ProviderName; model: string | undefined } {
  if (value === COMPOSITE_INHERIT) return { kind: 'inherit' };
  const idx = value.indexOf(':');
  if (idx < 0) return { kind: 'inherit' };
  const provider = value.slice(0, idx) as ProviderName;
  const model = value.slice(idx + 1);
  return { kind: 'override', provider, model: model || undefined };
}

/** "This Mac" / "This Windows PC" / "This Linux PC" — friendly label
 *  for on-device runtimes (mlx, llama-cpp). The runtime name (MLX vs
 *  llama.cpp) is folded into the provider key, not the prefix, so the
 *  user sees a stable "your computer" label across both. */
function platformLabel(): string {
  if (typeof navigator === 'undefined') return 'This computer';
  const ua = navigator.userAgent ?? '';
  if (/Mac/i.test(ua)) return 'This Mac';
  if (/Win/i.test(ua)) return 'This Windows PC';
  if (/Linux/i.test(ua)) return 'This Linux PC';
  return 'This computer';
}

function providerLabelFor(provider: ProviderName): string {
  switch (provider) {
    case 'copilot':
      return 'GitHub Copilot';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'anthropic-cli':
      return 'Claude CLI';
    case 'codex-cli':
      return 'Codex CLI';
    case 'ollama':
      return 'Ollama';
    case 'mlx':
    case 'llama-cpp':
      return platformLabel();
    case 'ds4':
      // Distinct from the MLX/llama.cpp "This Mac" entry — DwarfStar is a
      // separate engine with its own narrow model set, so its models get their
      // own row.
      return 'DwarfStar (ds4)';
    default:
      return provider;
  }
}

export function ProviderModelSelect({
  provider,
  model,
  onChange,
  globalProvider,
  disabled,
}: {
  /** Current per-gezel provider override, or null when inheriting. */
  provider: ProviderName | null;
  /** Current per-gezel model override (id), or undefined when inheriting. */
  model: string | undefined;
  /** Called with the new (provider, model) pair. `null` means inherit. */
  onChange: (provider: ProviderName | null, model: string | undefined) => void;
  /** Install-level default provider — used to label the "Inherit" row. */
  globalProvider: ProviderName;
  disabled?: boolean;
}) {
  const [entries, setEntries] = useState<ProviderEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [inventoryEpoch, setInventoryEpoch] = useState(0);
  const refreshEngineRef = useRef<GezmodelEngine | null>(null);

  // Read through a ref rather than an effect dependency: whether Copilot is
  // already the chosen provider must be current when the fetch runs, but it
  // is not a reason to re-fetch every provider's model list.
  const copilotAlreadyChosenRef = useRef(false);
  copilotAlreadyChosenRef.current = globalProvider === 'copilot' || provider === 'copilot';

  useEffect(() => {
    const onChanged = (event: Event) => {
      const engine = changedModelInventoryEngine(event);
      if (!engine) return;
      refreshEngineRef.current = engine;
      setInventoryEpoch((value) => value + 1);
    };
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      let cfg: Awaited<ReturnType<typeof api.getConfig>> | null = null;
      let copilot: Awaited<ReturnType<typeof api.getCopilotStatus>> | null = null;
      let memory: Awaited<ReturnType<typeof api.getMemoryProfile>> | null = null;
      try {
        // A daemon older than this UI has no `/copilot-status`; falling back
        // to `available: true` keeps the pre-existing behavior rather than
        // silently hiding a provider that works. Same for the memory profile:
        // null leaves the ds4 RAM gate unapplied instead of guessing.
        [cfg, copilot, memory] = await Promise.all([
          api.getConfig(),
          api.getCopilotStatus().catch(() => null),
          api.getMemoryProfile().catch(() => null),
        ]);
      } catch {
        if (!cancelled) {
          setEntries([]);
          setLoading(false);
        }
        return;
      }
      // Determine which providers MIGHT have models — the cheap
      // pre-filter that avoids hammering the listProviderModels API
      // on providers we know aren't wired. Cloud providers gate on
      // their `has*ApiKey` flag; CLI-driven providers gate on the
      // server-side binary detection probe (cached 60s); on-device
      // gates on platform (mlx for darwin-arm64, llama-cpp anywhere);
      // ollama always probes (the auto-start helper handles "not
      // running yet").
      const candidates: ProviderName[] = [];
      // Copilot's runtime is an opt-in download (Settings → GitHub Copilot),
      // so offer it only once it's actually installed — or when it's already
      // the chosen provider somewhere, so an existing selection isn't
      // stranded. We don't gate on a stored token: Copilot can authenticate
      // via the CLI without one, same as the Home onboarding probe assumes.
      if (copilot?.available !== false || copilotAlreadyChosenRef.current) {
        candidates.push('copilot');
      }
      if (cfg.hasOpenaiApiKey) candidates.push('openai');
      if (cfg.hasAnthropicApiKey) candidates.push('anthropic');
      // CLI providers — only show when the underlying binary is
      // actually installed. Without this, picking "Claude CLI" with
      // no `claude` on PATH lands an actionable error on the first
      // chat attempt; gating up front turns it into a non-option.
      if (cfg.anthropicCliStatus?.installed) candidates.push('anthropic-cli');
      if (cfg.codexCliStatus?.installed) candidates.push('codex-cli');
      candidates.push('ollama');
      // On-device — listProviderModels returns only DOWNLOADED
      // models for these, so an empty list means "nothing to show"
      // and the entry naturally drops out below.
      const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
      if (/Mac/i.test(ua)) candidates.push('mlx');
      candidates.push('llama-cpp');
      // DwarfStar (ds4) — a separate on-device engine. Offer it unless the
      // device definitively can't run it (Intel Mac / Windows / under the RAM
      // floor, all without an external ds4-server); the empty-list filter below
      // drops the entry when no ds4 model is installed.
      if (
        detectDs4Availability({
          externalBaseUrl: cfg.ds4BaseUrl,
          totalRamBytes: memory?.totalRamBytes,
        }).status !== 'unavailable'
      ) {
        candidates.push('ds4');
      }

      const settled = await Promise.all(
        candidates.map(async (p): Promise<ProviderEntry | null> => {
          try {
            const refresh =
              (p === 'llama-cpp' || p === 'mlx' || p === 'ds4') &&
              ((refreshEngineRef.current === p && inventoryEpoch > 0) ||
                modelInventoryRevision(p) > 0);
            const res = await api.listProviderModels(p, refresh ? { refresh: true } : undefined);
            if (res.models.length === 0) return null;
            return { provider: p, label: providerLabelFor(p), models: res.models };
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const filtered = settled.filter((e): e is ProviderEntry => e !== null);
      // Stable order: on-device providers first (the local-first
      // story is "your computer is the default surface"), then
      // cloud. Within each band, the order matches the historical
      // listing so muscle memory survives the reordering.
      const order: ProviderName[] = [
        'mlx',
        'llama-cpp',
        'ds4',
        'ollama',
        'copilot',
        'openai',
        'anthropic',
        'anthropic-cli',
        'codex-cli',
      ];
      filtered.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
      setEntries(filtered);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [inventoryEpoch]);

  const selectValue = useMemo(() => compositeValue(provider, model), [provider, model]);

  const inheritLabel = useMemo(() => {
    return `Inherit default (${providerLabelFor(globalProvider)})`;
  }, [globalProvider]);

  if (loading) {
    return <span className="muted small">loading providers…</span>;
  }
  if (!entries || entries.length === 0) {
    // No configured providers at all — degenerate case (fresh install,
    // no credentials, no on-device models). Render a disabled control
    // pointing at Settings.
    return (
      <span className="muted small">
        No providers configured —{' '}
        <button
          type="button"
          className="provider-model-select-link"
          onClick={() => {
            // Stash the target section first — the app-level `gezel:navigate`
            // handler only routes the `view`, so SettingsView picks the section
            // up from here on mount (otherwise it opens on General).
            requestSettingsSection('defaults');
            window.dispatchEvent(
              new CustomEvent('gezel:navigate', {
                detail: { view: 'settings', section: 'defaults' },
              }),
            );
          }}
        >
          set one up
        </button>
      </span>
    );
  }

  return (
    <Select.Root
      value={selectValue}
      onValueChange={(v) => {
        const parsed = parseComposite(v);
        if (parsed.kind === 'inherit') onChange(null, undefined);
        else onChange(parsed.provider, parsed.model);
      }}
      disabled={disabled}
    >
      <Select.Trigger>
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={COMPOSITE_INHERIT}>{inheritLabel}</Select.Item>
        {entries.map((entry) =>
          entry.models.map((m) => (
            <Select.Item key={`${entry.provider}:${m.id}`} value={`${entry.provider}:${m.id}`}>
              {entry.label} — {m.name}
              {m.supportsReasoning ? ' · reasoning' : ''}
            </Select.Item>
          )),
        )}
      </Select.Content>
    </Select.Root>
  );
}
