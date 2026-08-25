import {
  type CatalogItemSummary,
  type CatalogKind,
  type LicenseClass,
  type ModelAttribution,
  RETIRED_MODEL_TAG,
  RETIRED_MODEL_TOOLTIP,
  type ToolsetCategory,
  isRetiredModel,
  modelAttribution,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Tooltip } from '../primitives/index.js';
import { CatalogArtwork } from './CatalogArtwork.js';
import { RecommendedBadge } from './RecommendedBadge.js';

/**
 * Shared catalog browser. Given a `kind`, loads items via the catalog
 * HTTP API and renders a filterable grid. Parents supply an `action`
 * renderer that knows how to install / pull / create-from this item
 * (the catalog browser doesn't know how to install — that's kind-specific).
 *
 *   <CatalogBrowser
 *     kind="chat-model"
 *     action={(item) => <InstallOllamaButton tag={item.manifest.ollama.tag} … />}
 *   />
 */

const TOOLSET_CATEGORY_LABELS: Record<ToolsetCategory, string> = {
  search: 'Search',
  'dev-tools': 'Dev tools',
  data: 'Data',
  cloud: 'Cloud',
  productivity: 'Productivity',
  communication: 'Communication',
  content: 'Content',
  ai: 'AI',
  media: 'Media',
  other: 'Other',
};

/** Display order for category tabs — popular buckets first, "other" last. */
const TOOLSET_CATEGORY_ORDER: ToolsetCategory[] = [
  'search',
  'dev-tools',
  'data',
  'cloud',
  'productivity',
  'communication',
  'content',
  'media',
  'ai',
  'other',
];

function CatalogItemLogo({ item }: { item: CatalogItemSummary }) {
  return (
    <CatalogArtwork
      iconSvg={item.iconSvg}
      logoUrl={item.logoUrl}
      svgClassName="catalog-item-logo catalog-item-logo-svg"
      imageClassName="catalog-item-logo"
      fallback={
        <div className="catalog-item-logo catalog-item-logo-placeholder">
          {item.manifest.name.slice(0, 1)}
        </div>
      }
    />
  );
}

function catalogModelAttribution(item: CatalogItemSummary): ModelAttribution | null {
  if (item.manifest.kind === 'chat-model') return modelAttribution(item.manifest);
  if (item.manifest.kind === 'image-model' || item.manifest.kind === 'video-model') {
    return { maker: item.manifest.maintainer.name, customizers: [] };
  }
  return null;
}

/**
 * Narrow to the manifests that carry recommendation metadata. The ★ badge is
 * part of the card's identity block (name, maker, tags) rather than of the
 * kind-specific `action` footer, so every model catalog shows it in the same
 * place instead of wherever its manager happened to render it.
 */
function catalogModelReco(item: CatalogItemSummary): {
  recoScore?: number;
  licenseClass?: LicenseClass;
  supportsTools?: boolean;
  tags?: readonly string[];
} | null {
  const m = item.manifest;
  if (m.kind === 'chat-model' || m.kind === 'image-model' || m.kind === 'video-model') return m;
  return null;
}

export function CatalogBrowser({
  kind,
  action,
  emptyMessage,
  filterTags,
  filter,
  onItemsLoaded,
  tagTooltips,
  initialItems,
}: {
  kind: CatalogKind;
  action: (item: CatalogItemSummary) => React.ReactNode;
  emptyMessage?: string;
  /** Optional list of tags to filter to. Items matching any tag pass. */
  filterTags?: string[];
  /**
   * Optional predicate applied after tag + text filtering. Returns true to
   * keep an item. Used by OllamaModelManager to hide models that won't fit
   * in the detected memory budget.
   */
  filter?: (item: CatalogItemSummary) => boolean;
  /**
   * Called once per successful fetch with the full (unfiltered) item list.
   * Lets parents derive their own facets (e.g. category tabs) without
   * re-fetching the catalog themselves.
   */
  onItemsLoaded?: (items: CatalogItemSummary[]) => void;
  /**
   * Optional glossary applied to each tag pill. Keys are matched case-
   * insensitively. Jargon-heavy catalogs (e.g. LLM manifests with "moe",
   * "agentic") pass a dictionary so hovering a tag explains it.
   */
  tagTooltips?: Record<string, string>;
  /**
   * Optional pre-loaded items. When supplied the browser skips the
   * initial fetch and renders synchronously — used by parents that
   * already cache the catalog (e.g. `ToolsetsEditor` fetches it on
   * mount, long before the user opens the picker dialog). The Refresh
   * button still triggers a fresh fetch.
   */
  initialItems?: CatalogItemSummary[];
}) {
  const [items, setItems] = useState<CatalogItemSummary[]>(initialItems ?? []);
  const [loading, setLoading] = useState(initialItems === undefined);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<ToolsetCategory | 'all'>('all');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCatalogItems(kind);
      setItems(res.items);
      onItemsLoaded?.(res.items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kind, onItemsLoaded]);

  useEffect(() => {
    if (initialItems !== undefined) {
      // Parent already supplied items — adopt them when they change
      // and skip the auto-fetch entirely. Manual refresh remains.
      setItems(initialItems);
      setLoading(false);
      return;
    }
    void refresh();
  }, [refresh, initialItems]);

  // Per-category counts across the unfiltered list. Drives the tab
  // labels ("Search · 617") so users can see which buckets are big.
  const categoryCounts = useMemo(() => {
    if (kind !== 'toolset') return null;
    const counts = new Map<ToolsetCategory, number>();
    let totalCategorized = 0;
    for (const it of items) {
      if (it.manifest.kind !== 'toolset') continue;
      const cat = it.manifest.category ?? 'other';
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
      totalCategorized++;
    }
    if (totalCategorized === 0) return null;
    return counts;
  }, [items, kind]);

  const visible = useMemo(() => {
    let out = items;
    if (kind === 'toolset' && activeCategory !== 'all') {
      out = out.filter((i) => {
        if (i.manifest.kind !== 'toolset') return false;
        const cat = i.manifest.category ?? 'other';
        return cat === activeCategory;
      });
    }
    if (filterTags && filterTags.length > 0) {
      const required = new Set(filterTags);
      out = out.filter((i) => i.manifest.tags.some((t) => required.has(t.toLowerCase())));
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter((i) => {
        const attribution = catalogModelAttribution(i);
        return (
          i.manifest.name.toLowerCase().includes(q) ||
          i.manifest.description.toLowerCase().includes(q) ||
          i.manifest.tags.some((t) => t.toLowerCase().includes(q)) ||
          i.manifest.id.toLowerCase().includes(q) ||
          attribution?.maker.toLowerCase().includes(q) ||
          attribution?.customizers.some((name) => name.toLowerCase().includes(q))
        );
      });
    }
    if (filter) out = out.filter(filter);
    return out;
  }, [items, query, filterTags, filter, activeCategory, kind]);

  const isModelCatalog = kind === 'chat-model' || kind === 'image-model' || kind === 'video-model';

  return (
    <div className={`catalog-browser${isModelCatalog ? ' catalog-browser--models' : ''}`}>
      <div className="catalog-filter">
        <input placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {categoryCounts && categoryCounts.size > 0 && (
        <div className="catalog-categories" role="tablist" aria-label="Filter by category">
          <button
            type="button"
            role="tab"
            aria-selected={activeCategory === 'all'}
            className={`catalog-category${activeCategory === 'all' ? ' catalog-category-active' : ''}`}
            onClick={() => setActiveCategory('all')}
          >
            All <span className="catalog-category-count">{items.length}</span>
          </button>
          {TOOLSET_CATEGORY_ORDER.filter((c) => (categoryCounts.get(c) ?? 0) > 0).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={activeCategory === c}
              className={`catalog-category${activeCategory === c ? ' catalog-category-active' : ''}`}
              onClick={() => setActiveCategory(c)}
            >
              {TOOLSET_CATEGORY_LABELS[c]}{' '}
              <span className="catalog-category-count">{categoryCounts.get(c)}</span>
            </button>
          ))}
        </div>
      )}
      {loading && <p className="muted small">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && visible.length === 0 && (
        <p className="muted small">{emptyMessage ?? 'Nothing in the catalog for this kind yet.'}</p>
      )}
      <ul className="catalog-grid">
        {visible.map((item) => {
          const attribution = catalogModelAttribution(item);
          const reco = catalogModelReco(item);
          const retired = isRetiredModel(item.manifest);
          return (
            <li key={`${item.sourceId}:${item.manifest.id}`} className="catalog-item">
              <div className="catalog-item-header">
                <CatalogItemLogo item={item} />
                <div className="catalog-item-head">
                  <div className="catalog-item-name">{item.manifest.name}</div>
                  {attribution && (
                    <div className="catalog-item-attribution">
                      <div>
                        Made by <strong>{attribution.maker}</strong>
                      </div>
                      {attribution.customizers.length > 0 && (
                        <div>
                          Customized by <strong>{attribution.customizers.join(', ')}</strong>
                        </div>
                      )}
                    </div>
                  )}
                  {item.manifest.tags.length > 0 && (
                    <div className="catalog-item-tags">
                      {item.manifest.tags.map((t) => {
                        const normalizedTag = t.trim().toLowerCase();
                        const retiredTag = normalizedTag === RETIRED_MODEL_TAG;
                        const tip =
                          tagTooltips?.[normalizedTag] ??
                          (retiredTag ? RETIRED_MODEL_TOOLTIP : undefined);
                        const pill = (
                          <span
                            key={t}
                            className={`catalog-item-tag${retiredTag ? ' catalog-item-tag--retired' : ''}`}
                            style={tip ? { cursor: 'help' } : undefined}
                          >
                            {t}
                          </span>
                        );
                        if (!tip) return pill;
                        return (
                          <Tooltip.Hint key={t} text={tip}>
                            {pill}
                          </Tooltip.Hint>
                        );
                      })}
                    </div>
                  )}
                  {reco && !retired && <RecommendedBadge manifest={reco} />}
                </div>
              </div>
              <p className="catalog-item-description">{item.manifest.description}</p>
              <div className="catalog-item-action">{action(item)}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
