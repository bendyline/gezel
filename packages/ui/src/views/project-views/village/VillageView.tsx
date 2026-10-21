import type {
  FileMapResponse,
  FileMapScope,
  GitHubPullSummary,
  MapBlock,
  MapBuilding,
  MapPrChange,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api.js';
import {
  FileMap,
  type MapRendererKind,
  defaultRenderer,
} from '../../../components/FileMap/FileMap.js';
import { townStyleForBlock, townStyleLabel } from '../../../components/FileMap/iso/town-style.js';
import type { InspectorExtras } from '../types.js';

const PR_CHANGE_LABEL: Record<MapPrChange['change'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
};

const ZONE_LABEL: Record<NonNullable<MapBlock['health']>['zone'], string> = {
  residential: 'residential',
  commercial: 'commercial',
  civic: 'civic landmark',
  industrial: 'industrial',
};
const VIBE_LABEL: Record<NonNullable<MapBlock['health']>['vibe'], string> = {
  lush: 'lush',
  tidy: 'tidy',
  plain: 'plain',
  scruffy: 'scruffy',
  blighted: 'blighted',
};

/**
 * The scope toggle separates test files (their own settlement) from the core
 * code. Data files are fields, config files signal towers, stylesheets parks.
 */
const SCOPES: Array<{ value: FileMapScope; label: string }> = [
  { value: 'core', label: 'Code' },
  { value: 'tests', label: 'Tests' },
  { value: 'all', label: 'All' },
];

export interface VillageViewProps {
  projectId: string;
  /** Only a GitHub-linked project has pull requests; others answer 400. */
  hasGitHub?: boolean;
  selectedPath: string | null;
  onSelectPath: (path: string | null, opts?: { line?: number }) => void;
  /** What the shared inspector should add for the selected file. */
  setInspectorExtras: (extras: InspectorExtras | null) => void;
}

/**
 * The Village view: the codebase as a persistent 1890–1915 settlement.
 * Districts are folders, blocks are files (size ∝ LoC), buildings are symbols,
 * and roads are the import graph. Pan/zoom with the mouse; click a block and
 * the file opens in the shared inspector beside the map.
 */
export function VillageView({
  projectId,
  hasGitHub = false,
  selectedPath,
  onSelectPath,
  setInspectorExtras,
}: VillageViewProps) {
  const [model, setModel] = useState<FileMapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<FileMapScope>('core');
  const [pulls, setPulls] = useState<GitHubPullSummary[]>([]);
  const [pr, setPr] = useState<number | null>(null);
  const [ageLens, setAgeLens] = useState(false);
  const [renderer, setRenderer] = useState<MapRendererKind>(() => defaultRenderer());
  const [revision, setRevision] = useState(0);

  const selectBlockAtLine = useCallback(
    (block: MapBlock | null, line = 1) => {
      if (block && window.__GEZEL__?.openWorkspaceFile) {
        window.__GEZEL__.openWorkspaceFile(block.id, Math.max(1, line));
        return;
      }
      onSelectPath(block?.id ?? null, block ? { line: Math.max(1, line) } : undefined);
    },
    [onSelectPath],
  );

  const handleMapSelect = useCallback(
    (block: MapBlock | null, building?: MapBuilding | null) => {
      selectBlockAtLine(block, building?.lineStart ?? 1);
    },
    [selectBlockAtLine],
  );

  const load = useCallback(
    (opts: { upgradeEdges?: boolean } = {}) => {
      setLoading(true);
      setError(null);
      api
        .toolFileMap(projectId, {
          scope,
          ...(pr ? { pr } : {}),
          ...(opts.upgradeEdges ? { edgePolicy: 2 as const } : {}),
        })
        .then((m) => {
          setModel(m);
          // Facts may have changed under the inspector's cached context.
          setRevision((n) => n + 1);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [projectId, scope, pr],
  );
  const refresh = useCallback(() => load(), [load]);
  const upgrade = model?.edgePolicy?.upgrade;

  useEffect(() => {
    load();
  }, [load]);

  // A new scope or overlay is a different map; the selection belongs to the
  // old one. The first render keeps whatever another view selected.
  const lastFilter = useRef({ scope, pr });
  useEffect(() => {
    const prev = lastFilter.current;
    if (prev.scope === scope && prev.pr === pr) return;
    lastFilter.current = { scope, pr };
    onSelectPath(null);
  }, [scope, pr, onSelectPath]);

  // Best-effort PR list for the overlay picker.
  useEffect(() => {
    if (!hasGitHub) {
      setPulls([]);
      return;
    }
    let cancelled = false;
    api
      .listProjectGitHubPulls(projectId)
      .then((r) => {
        if (!cancelled) setPulls(r.pulls);
      })
      .catch(() => {
        if (!cancelled) setPulls([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, hasGitHub]);

  const overlayById = useMemo(
    () => new Map((model?.overlay?.changedBlocks ?? []).map((c) => [c.blockId, c])),
    [model],
  );

  // Blast radius: blocks that (transitively, ≤3 hops) import a changed file.
  // Roads are directed (a imports b), so a change to b ripples back to a; a
  // bidirectional road ripples both ways.
  const affectedIds = useMemo(() => {
    const overlay = model?.overlay;
    if (!model || !overlay || overlay.changedBlocks.length === 0) return undefined;
    const dependents = new Map<string, string[]>();
    const add = (key: string, dep: string) => {
      const list = dependents.get(key);
      if (list) list.push(dep);
      else dependents.set(key, [dep]);
    };
    for (const r of model.roads) {
      add(r.b, r.a); // a imports b ⇒ changing b affects a
      if (r.bidirectional) add(r.a, r.b);
    }
    const changed = new Set(overlay.changedBlocks.map((c) => c.blockId));
    const affected = new Set<string>();
    let frontier = [...changed];
    for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const dep of dependents.get(id) ?? []) {
          if (changed.has(dep) || affected.has(dep)) continue;
          affected.add(dep);
          next.push(dep);
        }
      }
      frontier = next;
    }
    return affected.size > 0 ? affected : undefined;
  }, [model]);

  const stats = useMemo(() => {
    if (!model) return null;
    const live = model.blocks.filter((b) => b.state !== 'tombstoned' && !b.phantom);
    return {
      files: live.length,
      folders: model.districts.length,
      roads: model.roads.length,
      symbols: live.reduce((n, b) => n + b.buildingCount, 0),
    };
  }, [model]);

  const selected = useMemo(
    () =>
      selectedPath && model ? (model.blocks.find((b) => b.id === selectedPath) ?? null) : null,
    [model, selectedPath],
  );

  // Files connected to the selected block by an import road (for navigation).
  const connected = useMemo(() => {
    if (!selected || !model) return [] as MapBlock[];
    const ids = new Set<string>();
    for (const r of model.roads) {
      if (r.a === selected.id) ids.add(r.b);
      else if (r.b === selected.id) ids.add(r.a);
    }
    const byId = new Map(model.blocks.map((b) => [b.id, b]));
    return [...ids]
      .sort()
      .map((id) => byId.get(id))
      .filter((b): b is MapBlock => !!b);
  }, [selected, model]);

  // What only the Village can say about the selected file rides into the
  // shared inspector: its building, its place in the town, the PR overlay.
  useEffect(() => {
    if (!selected) {
      setInspectorExtras({ onFindingsChanged: refresh, revision });
      return;
    }
    const prChange = overlayById.get(selected.id);
    setInspectorExtras({
      forPath: selected.id,
      known: {
        label: selected.label,
        lang: selected.lang ?? null,
        lines: selected.weight,
        symbols: selected.buildingCount,
      },
      connections: connected.map((b) => ({ path: b.id, label: b.label })),
      onFindingsChanged: refresh,
      revision,
      chips: (
        <>
          {renderer === 'iso' && (
            <span className="filemap-chip">{townStyleLabel(townStyleForBlock(selected))}</span>
          )}
          {selected.health && (
            <span className="filemap-chip">
              {ZONE_LABEL[selected.health.zone]} · {VIBE_LABEL[selected.health.vibe]}
            </span>
          )}
          {selected.health && (
            <span className="filemap-chip">↓{selected.health.fanIn} imported</span>
          )}
          {selected.health && (
            <span className="filemap-chip">↑{selected.health.fanOut} imports</span>
          )}
          {selected.health && selected.health.findings > 0 && (
            <span className="filemap-chip filemap-chip-warn">
              {selected.health.findings} finding{selected.health.findings > 1 ? 's' : ''}
              {selected.health.maxSeverity ? ` (max ${selected.health.maxSeverity})` : ''}
            </span>
          )}
          {selected.placedAt && (
            <span className="filemap-chip">since {selected.placedAt.slice(0, 10)}</span>
          )}
          {prChange && (
            <span className="filemap-chip">
              PR: {PR_CHANGE_LABEL[prChange.change]}{' '}
              <span className="filemap-add">+{prChange.additions}</span>{' '}
              <span className="filemap-del">−{prChange.deletions}</span>
            </span>
          )}
        </>
      ),
    });
  }, [connected, refresh, overlayById, renderer, revision, selected, setInspectorExtras]);

  useEffect(() => () => setInspectorExtras(null), [setInspectorExtras]);

  return (
    <section className="filemap-view">
      <header className="filemap-header">
        <div className="filemap-title">
          <strong>Village</strong>
          {stats && (
            <span className="filemap-stats">
              {stats.files} files · {stats.folders} neighborhoods · {stats.roads} roads ·{' '}
              {stats.symbols} symbols
            </span>
          )}
          {model?.overlay && (
            <span className="filemap-overlay-stat">
              PR #{model.overlay.prNumber} · {model.overlay.changedBlocks.length} changed
              {affectedIds ? ` · ${affectedIds.size} affected` : ''}
            </span>
          )}
        </div>
        <div className="filemap-actions">
          {upgrade && (
            <button
              type="button"
              className="filemap-refresh filemap-upgrade"
              disabled={loading}
              title={`The village can now see imports across packages and in more languages: ${upgrade.roadsAfter} roads instead of ${upgrade.roadsNow}. Buildings stay where they are; roads, downtown and landmarks follow the new graph.`}
              onClick={() => load({ upgradeEdges: true })}
            >
              Update the village
            </button>
          )}
          {pulls.length > 0 && (
            <select
              className="filemap-pr"
              aria-label="Overlay a pull request"
              value={pr ?? ''}
              onChange={(e) => setPr(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">No PR overlay</option>
              {pulls.map((p) => (
                <option key={p.number} value={p.number}>
                  #{p.number} {p.title}
                </option>
              ))}
            </select>
          )}
          <fieldset className="filemap-scope" aria-label="Village scope">
            {SCOPES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={scope === s.value ? 'active' : ''}
                aria-pressed={scope === s.value}
                onClick={() => setScope(s.value)}
              >
                {s.label}
              </button>
            ))}
          </fieldset>
          <fieldset className="filemap-scope" aria-label="Color lens">
            <button
              type="button"
              className={ageLens ? 'active' : ''}
              aria-pressed={ageLens}
              title="Color blocks by how recently they were added — the evolution lens"
              onClick={() => setAgeLens((v) => !v)}
            >
              Age
            </button>
          </fieldset>
          <fieldset className="filemap-scope" aria-label="Renderer">
            <button
              type="button"
              className={renderer === 'iso' ? 'active' : ''}
              aria-pressed={renderer === 'iso'}
              title="Isometric village view; toggle off for the flat top-down plan"
              onClick={() =>
                setRenderer((v) => {
                  const next = v === 'iso' ? 'flat' : 'iso';
                  try {
                    window.localStorage.setItem('gezel.mapRenderer', next);
                  } catch {
                    /* private-mode storage — the toggle still works this session */
                  }
                  return next;
                })
              }
            >
              3D
            </button>
          </fieldset>
          <button type="button" className="filemap-refresh" onClick={refresh} disabled={loading}>
            {loading ? 'Building…' : 'Rebuild'}
          </button>
        </div>
      </header>

      <div className="filemap-body">
        {error ? (
          <div className="filemap-empty">Couldn’t build the village: {error}</div>
        ) : model && !model.indexed ? (
          <div className="filemap-empty">
            This project hasn’t been indexed yet. The village appears once the workspace has been
            scanned.
          </div>
        ) : model && model.blocks.length === 0 && !loading ? (
          <div className="filemap-empty">
            {scope === 'tests' ? 'No test files found.' : 'No files to build a village from yet.'}
          </div>
        ) : model ? (
          <>
            <FileMap
              model={model}
              selectedId={selectedPath}
              onSelect={handleMapSelect}
              {...(affectedIds ? { affectedIds } : {})}
              renderer={renderer}
              ageLens={ageLens}
            />
            {!selectedPath && (
              <p className="filemap-hint filemap-hint-float">
                Scroll to zoom, drag to pan. Each building is a file; click one to open it.
              </p>
            )}
          </>
        ) : (
          <div className="filemap-empty">{loading ? 'Building the village…' : ''}</div>
        )}
      </div>
    </section>
  );
}
