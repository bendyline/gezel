import type { KnowledgeCatalogStatus } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

type ProjectDetail = Awaited<ReturnType<typeof api.updateProject>>;

/**
 * Project Settings → Knowledge catalogs: which of the user's installed
 * catalogs are in scope for THIS project. Settings owns the catalog refs;
 * this row only picks among them (docs/knowledge-catalogs.md). Renders
 * nothing when the user has no catalogs — the row would be an empty choice.
 */
export function ProjectKnowledgeRow({
  project,
  onUpdated,
}: {
  project: ProjectDetail;
  onUpdated: (updated: ProjectDetail) => void;
}) {
  const [catalogs, setCatalogs] = useState<KnowledgeCatalogStatus[]>([]);
  const mode = project.knowledgeCatalogs?.mode ?? 'inherit';
  const refs = project.knowledgeCatalogs?.refs ?? [];

  useEffect(() => {
    let cancelled = false;
    api
      .listKnowledgeCatalogs()
      .then((r) => {
        if (!cancelled) setCatalogs(r.catalogs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (next: { mode: 'inherit' | 'selected' | 'off'; refs?: typeof refs }) => {
      try {
        const updated = await api.updateProject(project.id, { knowledgeCatalogs: next });
        onUpdated(updated);
      } catch (err) {
        console.error('updateProject(knowledgeCatalogs) failed:', err);
      }
    },
    [project.id, onUpdated],
  );

  if (catalogs.length === 0) return null;

  const toggleRef = (publisherId: string, catalogId: string, checked: boolean) => {
    const without = refs.filter(
      (r) => !(r.publisherId === publisherId && r.catalogId === catalogId),
    );
    const nextRefs = checked ? [...without, { publisherId, catalogId }] : without;
    void save({ mode: 'selected', refs: nextRefs });
  };

  return (
    <label className="config-label" style={{ marginTop: '0.75rem' }}>
      Knowledge catalogs
      <div className="new-row" style={{ alignItems: 'center' }}>
        <select
          aria-label="Knowledge catalog scope"
          value={mode}
          onChange={(e) => {
            const nextMode = e.target.value as 'inherit' | 'selected' | 'off';
            void save(nextMode === 'selected' ? { mode: nextMode, refs } : { mode: nextMode });
          }}
        >
          <option value="inherit">All my catalogs</option>
          <option value="selected">Only selected catalogs</option>
          <option value="off">None for this project</option>
        </select>
      </div>
      {mode === 'selected' && (
        <fieldset className="project-tab-settings">
          <legend>Catalogs in scope</legend>
          <div className="project-tab-settings-grid">
            {catalogs.map((c) => {
              const checked = refs.some(
                (r) => r.publisherId === c.ref.publisherId && r.catalogId === c.ref.catalogId,
              );
              return (
                <label key={c.ref.catalogId} className="new-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      toggleRef(c.ref.publisherId, c.ref.catalogId, e.target.checked)
                    }
                  />
                  <span>{c.name ?? c.ref.catalogId}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <small className="muted">
        Reference material gezellen in this project can search and cite. Manage the catalogs
        themselves in Settings.
      </small>
    </label>
  );
}
