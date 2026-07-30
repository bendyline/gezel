import type { ModelInfo, ProviderName } from '@bendyline/gezel';
import { composeFitnessBadge } from '@bendyline/gezel';
import type { ModelFitnessEntry } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';

// Cache models per-provider for the lifetime of the page load so multiple
// <ModelPicker /> instances don't each issue their own request.
const inflight = new Map<ProviderName, Promise<ModelInfo[]>>();
const cached = new Map<ProviderName, ModelInfo[]>();

async function loadModels(provider: ProviderName): Promise<ModelInfo[]> {
  const hit = cached.get(provider);
  if (hit) return hit;
  const existing = inflight.get(provider);
  if (existing) return existing;
  const source =
    provider === 'remote'
      ? loadRemoteModels()
      : api.listProviderModels(provider).then((res) => res.models);
  const p = source
    .then((models) => {
      cached.set(provider, models);
      return models;
    })
    .finally(() => inflight.delete(provider));
  inflight.set(provider, p);
  return p;
}

/**
 * Aggregate chat models across every paired server, grouped by server name in
 * the label ("MacStudio · Qwen2.5 72B"). Each id is the namespaced
 * `remote:<remoteId>/<model>` the gezel stores. Offline servers are skipped.
 */
async function loadRemoteModels(): Promise<ModelInfo[]> {
  const { remotes } = await api.listRemotes();
  const out: ModelInfo[] = [];
  for (const r of remotes) {
    try {
      const { models } = await api.listRemoteModels(r.remoteId);
      for (const m of models) {
        out.push({
          id: m.id,
          name: `${r.displayName} · ${m.name}`,
          ...(m.supportsTools !== undefined ? { supportsTools: m.supportsTools } : {}),
          ...(m.supportsReasoning !== undefined ? { supportsReasoning: m.supportsReasoning } : {}),
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.parameterSize ? { parameterSize: m.parameterSize } : {}),
        });
      }
    } catch {
      /* server offline — skip its models */
    }
  }
  return out;
}

function isLocalProvider(p: ProviderName): p is 'mlx' | 'llama-cpp' {
  return p === 'mlx' || p === 'llama-cpp';
}

// Fitness records, fetched once per page load (same lifetime as the
// models cache above). Advisory pills only — a fetch failure just
// renders no pill.
let fitnessCache: Map<string, ModelFitnessEntry> | null = null;
let fitnessInflight: Promise<Map<string, ModelFitnessEntry>> | null = null;

async function loadFitness(): Promise<Map<string, ModelFitnessEntry>> {
  if (fitnessCache) return fitnessCache;
  if (fitnessInflight) return fitnessInflight;
  fitnessInflight = api
    .listModelFitness()
    .then((res) => {
      fitnessCache = new Map(res.records.map((r) => [r.key, r]));
      return fitnessCache;
    })
    .finally(() => {
      fitnessInflight = null;
    });
  return fitnessInflight;
}

interface LocalEmptyState {
  activeInstallsCount: number;
}

async function probeLocalEmpty(provider: 'mlx' | 'llama-cpp'): Promise<LocalEmptyState | null> {
  const [installed, active] = await Promise.all([
    provider === 'mlx' ? api.listMlxModels() : api.listLlamaCppModels(),
    provider === 'mlx' ? api.listMlxActiveInstalls() : api.listLlamaCppActiveInstalls(),
  ]);
  if (installed.models.length === 0) {
    return { activeInstallsCount: active.installs.length };
  }
  return null;
}

/**
 * Drop down over the provider's available models with an "Other…" escape
 * hatch for entries the SDK doesn't surface. Resolving selection:
 *   - undefined / '' → provider's own default is used
 *   - an id in the list → that model
 *   - a string not in the list → still kept (shows as "Other" with the id)
 */
export function ModelPicker({
  provider,
  value,
  onChange,
  placeholder = 'Provider default',
}: {
  provider: ProviderName;
  value: string | undefined;
  onChange: (model: string | undefined) => void;
  placeholder?: string;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(cached.get(provider) ?? null);
  const [loading, setLoading] = useState(!cached.has(provider));
  const [error, setError] = useState<string | null>(null);
  const [localEmpty, setLocalEmpty] = useState<LocalEmptyState | null>(null);
  const [otherMode, setOtherMode] = useState(false);
  const [otherDraft, setOtherDraft] = useState(value ?? '');
  const [fitness, setFitness] = useState<Map<string, ModelFitnessEntry> | null>(fitnessCache);

  useEffect(() => {
    if (provider !== 'llama-cpp' && provider !== 'ds4') return;
    let cancelled = false;
    loadFitness()
      .then((map) => {
        if (!cancelled) setFitness(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [provider]);

  useEffect(() => {
    setLoading(!cached.has(provider));
    setModels(cached.get(provider) ?? null);
    setError(null);
    setLocalEmpty(null);
    setOtherMode(false);
    // Guard against a provider-swap race: if the user switches from
    // 'copilot' to 'ollama' mid-request (e.g. GezellenView initializes
    // globalProvider='copilot' and updates after `api.getConfig()`),
    // a stale copilot 500 could land after the ollama success and
    // falsely set an error. Ignore any result for a provider we've
    // already moved past.
    let cancelled = false;
    loadModels(provider)
      .then(async (m) => {
        if (cancelled) return;
        // For local providers (MLX, llama.cpp), `listProviderModels`
        // returns a single placeholder when no models are installed, so
        // its length isn't a reliable empty signal. Probe the strict
        // installed-models endpoint and surface a friendlier state when
        // nothing is on disk yet — including a count of in-progress
        // downloads if the user is mid-install.
        if (isLocalProvider(provider)) {
          try {
            const empty = await probeLocalEmpty(provider);
            if (cancelled) return;
            if (empty) {
              setLocalEmpty(empty);
              setLoading(false);
              return;
            }
          } catch {
            // Local probe failed — fall through to the regular picker.
          }
        }
        setModels(m);
        setLoading(false);
      })
      .catch(async (err) => {
        if (cancelled) return;
        if (isLocalProvider(provider)) {
          try {
            const empty = await probeLocalEmpty(provider);
            if (cancelled) return;
            if (empty) {
              setLocalEmpty(empty);
              setLoading(false);
              return;
            }
          } catch {
            // Local probe failed too — show the original error.
          }
        }
        setError((err as Error).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  useEffect(() => {
    setOtherDraft(value ?? '');
  }, [value]);

  const isCustom = useMemo(() => {
    if (!value) return false;
    if (!models) return false;
    return !models.some((m) => m.id === value);
  }, [value, models]);

  const handleSelect = useCallback(
    (v: string) => {
      if (v === '__OTHER__') {
        setOtherMode(true);
        setOtherDraft(value ?? '');
        return;
      }
      if (v === '__CUSTOM__') return;
      onChange(v === '__DEFAULT__' ? undefined : v);
    },
    [onChange, value],
  );

  const commitOther = useCallback(() => {
    onChange(otherDraft.trim() || undefined);
    setOtherMode(false);
  }, [otherDraft, onChange]);

  if (loading) {
    return <span className="muted small">loading models…</span>;
  }
  if (localEmpty) {
    const n = localEmpty.activeInstallsCount;
    const msg =
      n > 0
        ? `No models downloaded; ${n} download${n === 1 ? '' : 's'} in progress`
        : 'No models downloaded';
    return <span className="muted small">{msg}</span>;
  }
  if (error) {
    return (
      <span className="error small" title={error}>
        failed to load
      </span>
    );
  }

  if (otherMode) {
    return (
      <span className="model-picker-other">
        <input
          type="text"
          value={otherDraft}
          onChange={(e) => setOtherDraft(e.target.value)}
          placeholder="Model ID"
        />
        <button type="button" onClick={commitOther}>
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setOtherMode(false);
            setOtherDraft(value ?? '');
          }}
        >
          Cancel
        </button>
      </span>
    );
  }

  const selectValue = isCustom ? '__CUSTOM__' : value || '__DEFAULT__';
  const selectedInfo = value ? models?.find((m) => m.id === value) : undefined;
  const toolsUnknown = selectedInfo && selectedInfo.supportsTools === false;
  // Fresh non-admitted proeve result on the selected local model →
  // loud advisory pill. Stale/failed/missing records render nothing
  // (the model manager's Fitness column is the full surface).
  const fitnessEntry =
    value && (provider === 'llama-cpp' || provider === 'ds4')
      ? fitness?.get(`${provider}:${value}`)
      : undefined;
  const fitnessBadge =
    fitnessEntry && !fitnessEntry.stale && fitnessEntry.record.status === 'probed'
      ? composeFitnessBadge({
          fitness: {
            record: fitnessEntry.record,
            stale: fitnessEntry.stale,
            hardwareChanged: fitnessEntry.hardwareChanged,
          },
        })
      : null;
  return (
    <span className="model-picker-wrap">
      <Select.Root value={selectValue} onValueChange={handleSelect}>
        <Select.Trigger>
          <Select.Value placeholder={placeholder} />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="__DEFAULT__">{placeholder}</Select.Item>
          {models?.map((m) => (
            <Select.Item key={m.id} value={m.id}>
              {m.name}
              {m.supportsReasoning ? ' · reasoning' : ''}
            </Select.Item>
          ))}
          {isCustom && <Select.Item value="__CUSTOM__">{value} (custom)</Select.Item>}
          <Select.Item value="__OTHER__">Other…</Select.Item>
        </Select.Content>
      </Select.Root>
      {toolsUnknown && (
        <span
          className="model-picker-warn"
          title="This model doesn't support structured tool calls, so gezellen on it can't use MCP tools (read/write files, create tasks, etc.). Pick a tool-capable model (llama3.1+, qwen2.5+, mistral, gpt-oss, etc.) if you need tool use."
        >
          no tools
        </span>
      )}
      {fitnessBadge?.tier === 'warn' && (
        <span className="model-picker-warn" title={fitnessBadge.detail}>
          fitness: {fitnessBadge.label}
        </span>
      )}
    </span>
  );
}

/**
 * Effort picker that renders nothing when the selected model doesn't support
 * reasoning effort. Looks up the allowed values from the model list.
 */
export function EffortPicker({
  provider,
  model,
  value,
  onChange,
}: {
  provider: ProviderName;
  model: string | undefined;
  value: string | undefined;
  onChange: (effort: string | undefined) => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(cached.get(provider) ?? null);

  useEffect(() => {
    loadModels(provider)
      .then(setModels)
      .catch(() => {});
  }, [provider]);

  if (!model || !models) return null;
  const info = models.find((m) => m.id === model);
  if (!info?.supportsReasoning) return null;
  const options = info.reasoningEfforts ?? ['low', 'medium', 'high'];
  const defaultLabel = info.defaultReasoningEffort
    ? `Default (${info.defaultReasoningEffort})`
    : 'Default';
  return (
    <Select.Root
      value={value || '__DEFAULT__'}
      onValueChange={(v) => onChange(v === '__DEFAULT__' ? undefined : v)}
    >
      <Select.Trigger aria-label="Reasoning effort">
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="__DEFAULT__">{defaultLabel}</Select.Item>
        {options.map((e) => (
          <Select.Item key={e} value={e}>
            {e}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
