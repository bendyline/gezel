import type {
  CatalogItemSummary,
  ChatModelCategory,
  ChatModelManifest,
  ModelInfo,
} from '@bendyline/gezel';
import type { OllamaPullChunk } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { LicenseButton } from './LicenseButton.js';

interface MemoryProfile {
  platform: string;
  totalRamBytes: number;
  gpuVramBytes: number | null;
  source: 'darwin-unified' | 'gpu-nvidia' | 'gpu-vulkan' | 'system-ram-fallback';
  usableBytes: number;
}

/**
 * Running a model needs weights + KV cache + context + inference overhead.
 * A 1.2× multiplier on the on-disk size is a practical lower bound for
 * 4-bit quantized Ollama models.
 */
const MEMORY_OVERHEAD_FACTOR = 1.2;

/**
 * Glossary for jargon-y tags on Ollama manifests. Hovering any of these
 * shows the plain-English explanation so a first-time user can make sense
 * of "MoE" or "agentic" without leaving the picker.
 */
const OLLAMA_TAG_TOOLTIPS: Record<string, string> = {
  'mix of experts':
    "Only a fraction of the model's parameters run per token, so it's faster than a dense model of the same nominal size. Gezels generally benefit from MoE models.",
  moe: "Only a fraction of the model's parameters run per token, so it's faster than a dense model of the same nominal size. Gezels generally benefit from MoE models.",
  thinking:
    'The model reasons through the problem step-by-step before answering. Slower, but generally more accurate on hard questions.',
  agentic:
    'Tuned for multi-step agent workflows — tool use, planning, and iterating toward a goal.',
  vision: 'Can accept images alongside text.',
  tools: 'Supports function/tool calling via the API.',
  multimodal: 'Handles multiple input types (text + images).',
  large: 'Heavy model — needs a lot of memory and runs more slowly.',
  small: 'Compact model — runs quickly on modest hardware.',
};

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

interface ActivePull {
  name: string;
  status: string;
  completed: number;
  total: number;
  error?: string;
  controller: AbortController;
}

function formatApproxSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `~${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `~${(bytes / 1_000_000).toFixed(0)} MB`;
  return `~${bytes} B`;
}

function formatReleased(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

interface Props {
  /**
   * True when Ollama is reachable. When false, the picker is disabled with
   * an explanatory note — avoids double-fetching `/api/models` when we know
   * the server's down.
   */
  enabled: boolean;
  /**
   * Called whenever the installed model list changes (install succeeded,
   * delete succeeded). The Home tab uses this to re-run its probe so the
   * "no models yet" state flips to "ready" without a page reload.
   */
  onModelsChanged?: () => void;
  /** When true, swap headings for compact copy suitable for onboarding. */
  compact?: boolean;
}

/**
 * The shared Ollama model install/pick UX. Used by both Settings
 * (full view) and the Home tab's onboarding flow (when Ollama is up but
 * no models are installed yet). Owns the installed-models fetch, pull
 * lifecycle, delete confirmation, and catalog picker.
 */
type CategoryTab = ChatModelCategory | 'all';

/**
 * The chat-model catalog kind is shared between Ollama and llama.cpp.
 * This component is the Ollama-specific surface, so we narrow each
 * catalog item to "chat-model with an `ollama` source block" before
 * pulling fields out — entries that exist only as llama.cpp GGUFs
 * are not relevant here.
 */
function asOllamaChatModel(
  m: CatalogItemSummary['manifest'],
): (ChatModelManifest & { ollama: NonNullable<ChatModelManifest['ollama']> }) | null {
  if (m.kind !== 'chat-model') return null;
  if (!m.ollama) return null;
  return m as ChatModelManifest & { ollama: NonNullable<ChatModelManifest['ollama']> };
}

export function OllamaModelManager({ enabled, onModelsChanged, compact = false }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [pulls, setPulls] = useState<Map<string, ActivePull>>(new Map());
  const [customPull, setCustomPull] = useState('');
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryProfile | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [activeCategory, setActiveCategory] = useState<CategoryTab>('all');
  const [catalogItems, setCatalogItems] = useState<CatalogItemSummary[]>([]);
  const pullsRef = useRef(pulls);
  pullsRef.current = pulls;
  const startPullRef = useRef<((name: string) => Promise<void>) | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMemoryProfile()
      .then((p) => {
        if (!cancelled) setMemory(p);
      })
      .catch(() => {
        /* filtering silently disabled on probe failure */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const res = await api.listProviderModels('ollama');
      setModels(res.models);
      setModelsError(null);
    } catch (err) {
      setModelsError((err as Error).message);
      setModels([]);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refreshModels();
  }, [enabled, refreshModels]);

  // Auto-resume pending pulls on mount. The service persists pull intents
  // to `~/.gezel/pending-pulls.json` — anything in that list that isn't
  // already installed gets re-initiated here. Ollama resumes from the
  // last completed blob, so the user sees progress immediately without
  // having to click Install again.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ pulls: pending }, { models: installed }] = await Promise.all([
          api.listPendingOllamaPulls(),
          api.listProviderModels('ollama'),
        ]);
        if (cancelled) return;
        const installedSet = new Set(installed.map((m) => m.id));
        for (const p of pending) {
          // Skip tags that are already installed — the pull must have
          // finished while the app was closed (before we could mark it
          // "success"). Clean up the stale entry.
          if (installedSet.has(p.name)) {
            void api.clearPendingOllamaPull(p.name).catch(() => {});
            continue;
          }
          if (pullsRef.current.has(p.name)) continue;
          void startPullRef.current?.(p.name);
        }
      } catch {
        /* best-effort — if this fails, user can still click Install manually */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const startPull = useCallback(
    async (name: string) => {
      if (pullsRef.current.has(name)) return;
      const controller = new AbortController();
      const seed: ActivePull = {
        name,
        status: 'queued',
        completed: 0,
        total: 0,
        controller,
      };
      setPulls((prev) => new Map(prev).set(name, seed));
      try {
        await api.pullOllamaModel(
          name,
          (event) => {
            if (event.type === 'progress') {
              const chunk = event.chunk as OllamaPullChunk;
              setPulls((prev) => {
                const next = new Map(prev);
                const cur = next.get(name);
                if (!cur) return prev;
                next.set(name, {
                  ...cur,
                  status: chunk.status,
                  completed: chunk.completed ?? cur.completed,
                  total: chunk.total ?? cur.total,
                });
                return next;
              });
            } else if (event.type === 'error') {
              setPulls((prev) => {
                const next = new Map(prev);
                const cur = next.get(name);
                if (cur) next.set(name, { ...cur, error: event.error });
                return next;
              });
            }
          },
          controller.signal,
        );
        setTimeout(() => {
          setPulls((prev) => {
            const next = new Map(prev);
            next.delete(name);
            return next;
          });
          void refreshModels();
          onModelsChanged?.();
          // If the user had no Ollama default model configured, the one
          // they just pulled becomes the default. Makes new chat sessions
          // land on a known-installed tag instead of the fallback path.
          void (async () => {
            try {
              const cfg = await api.getConfig();
              if (!cfg.defaultModel?.ollama) {
                await api.updateConfig({
                  defaultModel: { ...cfg.defaultModel, ollama: name },
                });
              }
            } catch {
              /* best-effort */
            }
          })();
        }, 900);
      } catch (err) {
        if (controller.signal.aborted) {
          setPulls((prev) => {
            const next = new Map(prev);
            next.delete(name);
            return next;
          });
          return;
        }
        setPulls((prev) => {
          const next = new Map(prev);
          const cur = next.get(name);
          if (cur) next.set(name, { ...cur, error: (err as Error).message });
          return next;
        });
      }
    },
    [refreshModels, onModelsChanged],
  );
  startPullRef.current = startPull;

  const cancelPull = useCallback((name: string) => {
    const pull = pullsRef.current.get(name);
    pull?.controller.abort();
    // Explicit user cancel — clear the pending-pull record so we don't
    // auto-resume on next launch. If this fails (server down, etc.)
    // we'll re-resume harmlessly next time.
    void api.clearPendingOllamaPull(name).catch(() => {});
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!toDelete) return;
    try {
      await api.deleteOllamaModel(toDelete);
      await refreshModels();
      onModelsChanged?.();
    } catch (err) {
      setModelsError((err as Error).message);
    } finally {
      setToDelete(null);
    }
  }, [toDelete, refreshModels, onModelsChanged]);

  const installedNames = useMemo(() => new Set(models.map((m) => m.id)), [models]);

  // What category tabs to show, in a stable order. "All" is always first.
  // Only show categories for which the catalog actually has entries — no
  // empty tabs.
  const availableCategories = useMemo<CategoryTab[]>(() => {
    const present = new Set<ChatModelCategory>();
    for (const item of catalogItems) {
      const m = asOllamaChatModel(item.manifest);
      if (!m) continue;
      present.add(m.category ?? 'general');
    }
    const order: ChatModelCategory[] = ['general', 'coding', 'reasoning', 'vision', 'embedding'];
    return ['all' as CategoryTab, ...order.filter((c) => present.has(c))];
  }, [catalogItems]);

  /**
   * Tags that earn the "Recommended" badge: one per category, picked as
   * the largest model in that category whose fit check passes. On the
   * "All" tab we show all category winners, so users see Google's best +
   * Qwen's best side by side. On a specific-category tab, only that
   * category's winner shows up.
   *
   * Models that cannot call tools are never eligible, matching core's
   * `isRecommendedModel` — a gezel works through its toolset, so recommending
   * a tool-less model would hand the user a crew member with no hands.
   */
  const recommendedTags = useMemo<Set<string>>(() => {
    if (!memory) return new Set();
    const budget = memory.usableBytes;
    const winners = new Map<ChatModelCategory, { tag: string; size: number }>();
    for (const item of catalogItems) {
      const m = asOllamaChatModel(item.manifest);
      if (!m) continue;
      if (m.supportsTools === false) continue;
      if (m.approxSizeBytes * MEMORY_OVERHEAD_FACTOR > budget) continue;
      const cat = (m.category ?? 'general') as ChatModelCategory;
      if (activeCategory !== 'all' && cat !== activeCategory) continue;
      const cur = winners.get(cat);
      if (!cur || m.approxSizeBytes > cur.size) {
        winners.set(cat, { tag: m.ollama.tag, size: m.approxSizeBytes });
      }
    }
    return new Set([...winners.values()].map((v) => v.tag));
  }, [catalogItems, memory, activeCategory]);

  return (
    <div className="ollama-model-manager">
      {pulls.size > 0 && (
        <div className="ollama-section">
          <h4>Downloading…</h4>
          <div className="ollama-pull-list">
            {Array.from(pulls.values()).map((pull) => (
              <OllamaPullProgress
                key={pull.name}
                pull={pull}
                onCancel={() => cancelPull(pull.name)}
              />
            ))}
          </div>
        </div>
      )}

      {(models.length > 0 || modelsError) && (
        <div className="ollama-section">
          <h4>{compact ? 'Models on this device' : 'Local models'}</h4>
          {modelsError && <p className="error">{modelsError}</p>}
          {models.length > 0 && (
            <table className="ollama-model-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Tools</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <code>{m.id}</code>
                    </td>
                    <td>{m.parameterSize ?? '—'}</td>
                    <td>
                      {m.supportsTools ? (
                        <span className="home-status-pill home-status-ok">✓</span>
                      ) : (
                        <span className="home-status-pill home-status-warn">no</span>
                      )}
                    </td>
                    <td>
                      <button type="button" className="home-link" onClick={() => setToDelete(m.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="ollama-section ollama-section--flat ollama-section--download">
        <h4>Download a model</h4>
        <MemoryBudgetLine memory={memory} showAll={showAll} setShowAll={setShowAll} />
        <CategoryTabs
          active={activeCategory}
          onChange={setActiveCategory}
          available={availableCategories}
        />
        <CatalogBrowser
          kind="chat-model"
          emptyMessage="No model recommendations in the catalog yet."
          onItemsLoaded={setCatalogItems}
          tagTooltips={OLLAMA_TAG_TOOLTIPS}
          filter={(item: CatalogItemSummary) => {
            // Hide entries that don't have an ollama source — those
            // are llama.cpp-only and have no place in this picker.
            const m = asOllamaChatModel(item.manifest);
            if (!m) return false;
            // Category filter first.
            if (activeCategory !== 'all' && (m.category ?? 'general') !== activeCategory) {
              return false;
            }
            // Fit filter — hide oversized models unless the user opted in.
            if (!showAll && memory) {
              if (m.approxSizeBytes * MEMORY_OVERHEAD_FACTOR > memory.usableBytes) return false;
            }
            return true;
          }}
          action={(item: CatalogItemSummary) => {
            const m = asOllamaChatModel(item.manifest);
            if (!m) return null;
            const tag = m.ollama.tag;
            const installed = installedNames.has(tag);
            const activePull = pulls.get(tag);
            const pulling = Boolean(activePull);
            const pullPct =
              activePull && activePull.total > 0
                ? Math.min(100, Math.round((activePull.completed / activePull.total) * 100))
                : null;
            const tight = memory
              ? m.approxSizeBytes * MEMORY_OVERHEAD_FACTOR > memory.usableBytes
              : false;
            const recommended = recommendedTags.has(tag);
            return (
              <div className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <code>{tag}</code>
                    <span>·</span>
                    <span>{m.parameterSize}</span>
                    <span>·</span>
                    <span>{formatApproxSize(m.approxSizeBytes)}</span>
                    {formatReleased(m.releasedAt) && (
                      <>
                        <span>·</span>
                        <span>{formatReleased(m.releasedAt)}</span>
                      </>
                    )}
                  </div>
                  <div className="catalog-ollama-pills">
                    <LicenseButton manifest={m} allowOllamaLink />
                    {recommended && (
                      <span
                        className="home-status-pill home-status-ok"
                        title="Largest model in this category that fits your device's memory budget — a good default."
                      >
                        ★ recommended
                      </span>
                    )}
                    {tight && (
                      <span
                        className="home-status-pill home-status-warn"
                        title="This model is larger than the memory Gezel estimates your device can dedicate to inference. It may run very slowly or fail to load."
                      >
                        may not fit
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={installed || pulling || !enabled}
                  onClick={() => void startPull(tag)}
                >
                  {installed
                    ? 'On device'
                    : pulling
                      ? pullPct !== null
                        ? `Downloading… ${pullPct}%`
                        : 'Downloading…'
                      : 'Download'}
                </button>
              </div>
            );
          }}
        />

        <div className="new-row" style={{ marginTop: '0.5rem' }}>
          <input
            placeholder="Or download by name: e.g. qwen2.5-coder:14b"
            value={customPull}
            onChange={(e) => setCustomPull(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            disabled={!customPull.trim() || pulls.has(customPull.trim()) || !enabled}
            onClick={() => {
              const name = customPull.trim();
              if (name) {
                void startPull(name);
                setCustomPull('');
              }
            }}
          >
            Download
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete model?"
        message={
          toDelete
            ? `"${toDelete}" will be removed from your device. This frees disk space, but you'll need to download it again to use it.`
            : ''
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function MemoryBudgetLine({
  memory,
  showAll,
  setShowAll,
}: {
  memory: MemoryProfile | null;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
}) {
  if (!memory) return null;
  const usable = formatBytes(memory.usableBytes);
  return (
    <p className="muted small" style={{ marginTop: 0 }}>
      Models larger than your ~{usable} budget are hidden by default.{' '}
      <button type="button" className="home-link" onClick={() => setShowAll(!showAll)}>
        {showAll ? 'Hide oversized models' : 'Include oversized models'}
      </button>
    </p>
  );
}

const CATEGORY_LABELS: Record<CategoryTab, string> = {
  all: 'All',
  general: 'General',
  coding: 'Coding',
  reasoning: 'Reasoning',
  vision: 'Vision',
  embedding: 'Embedding',
};

function CategoryTabs({
  active,
  onChange,
  available,
}: {
  active: CategoryTab;
  onChange: (next: CategoryTab) => void;
  available: CategoryTab[];
}) {
  if (available.length <= 1) return null; // No useful filter if only "All" is available.
  return (
    <div
      className="ollama-category-tabs"
      role="tablist"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.4rem',
        margin: '0.5rem 0 0.75rem',
      }}
    >
      {available.map((c) => (
        <button
          key={c}
          type="button"
          role="tab"
          aria-selected={active === c}
          className={`provider-pill${active === c ? ' provider-pill-active' : ''}`}
          onClick={() => onChange(c)}
        >
          {CATEGORY_LABELS[c]}
        </button>
      ))}
    </div>
  );
}

function OllamaPullProgress({
  pull,
  onCancel,
}: {
  pull: ActivePull;
  onCancel: () => void;
}) {
  const known = pull.total > 0;
  const pct = known ? Math.min(100, Math.round((pull.completed / pull.total) * 100)) : 0;
  const statusLine = pull.error
    ? pull.error
    : known
      ? `Downloading… (${pct}%)`
      : `${initialCaps(pull.status)}…`;
  return (
    <div className={`ollama-pull${pull.error ? ' ollama-pull-error' : ''}`}>
      <div className="ollama-pull-head">
        <code>{pull.name}</code>
        <span className="muted small">{statusLine}</span>
        <button type="button" className="home-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {known ? (
        <div className="ollama-pull-bar">
          <div className="ollama-pull-bar-fill" style={{ width: `${pct}%` }} />
          <span className="ollama-pull-bar-label">{pct}%</span>
        </div>
      ) : (
        /* Indeterminate bar for the manifest-fetch / verify phases where
           Ollama hasn't told us a total yet. Keeps the UI feeling alive. */
        <div className="ollama-pull-bar ollama-pull-bar-indeterminate">
          <div className="ollama-pull-bar-fill" />
        </div>
      )}
    </div>
  );
}

function initialCaps(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
