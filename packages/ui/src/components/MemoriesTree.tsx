import type { Project } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

/**
 * Read-only tree of a gezel's memories, split into a general (gezel-scoped)
 * pool + one subtree per project the gezel has memories in. Each leaf is a
 * daily markdown file; a separate "summary" entry sits at the top of each
 * scope when one exists. Clicking a leaf loads its content into the right
 * preview pane.
 *
 * Built as a debugging / curiosity surface — gezels write memory files via
 * `save_memory` + the auto-summarizer, and until now there's been no way to
 * look at what's actually in there without opening the files on disk.
 */

type SelectedNode =
  | { kind: 'summary'; scope: 'gezel' | 'project'; id: string; label: string }
  | { kind: 'lessons'; scope: 'gezel'; id: string; label: string }
  | { kind: 'day'; scope: 'gezel' | 'project'; id: string; day: string; label: string };

interface ScopeTree {
  scope: 'gezel' | 'project';
  id: string;
  label: string;
  summary: string | null;
  /** Distilled lessons.md — gezel scope only. */
  lessons: string | null;
  days: string[];
  expanded: boolean;
}

export function MemoriesTree({
  gezelId,
  gezelName,
}: {
  gezelId: string;
  gezelName: string;
}) {
  const [trees, setTrees] = useState<ScopeTree[] | null>(null);
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [preview, setPreview] = useState<{
    loading: boolean;
    content: string | null;
    error: string | null;
  }>({ loading: false, content: null, error: null });

  // Load the gezel's own memory scope + every project's scope in parallel.
  // Projects that have zero days + no summary are dropped — an empty
  // project shouldn't clutter the tree.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [gezelDays, gezelSummary, gezelLessons, projects] = await Promise.all([
          api
            .listMemoryDays('gezel', gezelId)
            .then((r) => r.days)
            .catch(() => [] as string[]),
          api
            .readMemorySummary('gezel', gezelId)
            .then((r) => r.content)
            .catch(() => ''),
          api
            .readMemoryLessons(gezelId)
            .then((r) => r.content)
            .catch(() => ''),
          api
            .listProjects()
            .then((r) => r.projects)
            .catch(() => [] as Project[]),
        ]);
        const projectScopes: Array<ScopeTree | null> = await Promise.all(
          projects.map(async (p): Promise<ScopeTree | null> => {
            const [days, summary] = await Promise.all([
              api
                .listMemoryDays('project', p.id)
                .then((r) => r.days)
                .catch(() => [] as string[]),
              api
                .readMemorySummary('project', p.id)
                .then((r) => r.content)
                .catch(() => ''),
            ]);
            if (days.length === 0 && !summary) return null;
            return {
              scope: 'project',
              id: p.id,
              label: p.name,
              summary: summary || null,
              lessons: null,
              days,
              expanded: false,
            };
          }),
        );
        if (cancelled) return;
        const next: ScopeTree[] = [
          {
            scope: 'gezel' as const,
            id: gezelId,
            label: `${gezelName} (general)`,
            summary: gezelSummary || null,
            lessons: gezelLessons || null,
            days: gezelDays,
            expanded: true,
          },
          ...projectScopes.filter((s): s is ScopeTree => s !== null),
        ];
        setTrees(next);
      } catch {
        if (!cancelled) setTrees([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gezelId, gezelName]);

  // Load the selected node's content lazily.
  useEffect(() => {
    if (!selected) {
      setPreview({ loading: false, content: null, error: null });
      return;
    }
    let cancelled = false;
    setPreview({ loading: true, content: null, error: null });
    void (async () => {
      try {
        const res =
          selected.kind === 'summary'
            ? await api.readMemorySummary(selected.scope, selected.id)
            : selected.kind === 'lessons'
              ? await api.readMemoryLessons(selected.id)
              : await api.readMemoryDay(selected.scope, selected.id, selected.day);
        if (!cancelled) setPreview({ loading: false, content: res.content, error: null });
      } catch (err) {
        if (!cancelled)
          setPreview({ loading: false, content: null, error: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggleExpand = useCallback((idx: number) => {
    setTrees((prev) =>
      prev ? prev.map((t, i) => (i === idx ? { ...t, expanded: !t.expanded } : t)) : prev,
    );
  }, []);

  const totalDays = useMemo(() => trees?.reduce((acc, t) => acc + t.days.length, 0) ?? 0, [trees]);

  if (trees === null) {
    return <p className="muted small">Loading memories…</p>;
  }
  if (
    trees.length === 0 ||
    (trees.length === 1 && trees[0]!.days.length === 0 && !trees[0]!.summary)
  ) {
    return (
      <p className="placeholder">
        No memories yet. Gezels write these via <code>save_memory</code> during chat and the
        auto-summarizer drops a daily digest when a session is archived. Start a chat to see entries
        appear here.
      </p>
    );
  }

  return (
    <div className="memories-pane" data-testid="memories-tree">
      <div className="memories-tree" role="tree">
        <p className="memories-tree-total muted small">
          {totalDays} day{totalDays === 1 ? '' : 's'} across {trees.length} scope
          {trees.length === 1 ? '' : 's'}.
        </p>
        {trees.map((tree, idx) => (
          <TreeNode
            key={`${tree.scope}:${tree.id}`}
            tree={tree}
            onToggle={() => toggleExpand(idx)}
            onSelect={setSelected}
            selected={selected}
          />
        ))}
      </div>
      <div className="memories-preview">
        {selected ? (
          <>
            <header className="memories-preview-header">
              <code>{selected.label}</code>
            </header>
            {preview.loading && <p className="muted small">Loading…</p>}
            {preview.error && <p className="error">{preview.error}</p>}
            {preview.content !== null && !preview.loading && !preview.error && (
              <pre className="memories-preview-body">{preview.content || '(empty)'}</pre>
            )}
          </>
        ) : (
          <p className="placeholder">Select a scope / day on the left to view its contents.</p>
        )}
      </div>
    </div>
  );
}

function TreeNode({
  tree,
  onToggle,
  onSelect,
  selected,
}: {
  tree: ScopeTree;
  onToggle: () => void;
  onSelect: (node: SelectedNode) => void;
  selected: SelectedNode | null;
}) {
  const prefix = tree.scope === 'gezel' ? '🧠' : '📁';
  const summarySelected =
    selected?.kind === 'summary' && selected.scope === tree.scope && selected.id === tree.id;
  const lessonsSelected = selected?.kind === 'lessons' && selected.id === tree.id;

  return (
    <div className="memories-tree-scope" role="treeitem" aria-expanded={tree.expanded}>
      <button type="button" className="memories-tree-scope-header" onClick={onToggle}>
        <span className="memories-tree-caret" aria-hidden>
          {tree.expanded ? '▾' : '▸'}
        </span>
        <span>{prefix}</span>
        <span className="memories-tree-scope-label">{tree.label}</span>
        <span className="muted small">
          {tree.days.length} day{tree.days.length === 1 ? '' : 's'}
          {tree.lessons ? ' + lessons' : ''}
          {tree.summary ? ' + summary' : ''}
        </span>
      </button>
      {tree.expanded && (
        <ul className="memories-tree-children">
          {tree.scope === 'gezel' && tree.lessons && (
            <li>
              <button
                type="button"
                className={`memories-tree-leaf${lessonsSelected ? ' memories-tree-leaf-active' : ''}`}
                onClick={() =>
                  onSelect({
                    kind: 'lessons',
                    scope: 'gezel',
                    id: tree.id,
                    label: `${tree.label} · lessons`,
                  })
                }
              >
                <span aria-hidden>🎓</span> lessons
              </button>
            </li>
          )}
          {tree.summary && (
            <li>
              <button
                type="button"
                className={`memories-tree-leaf${summarySelected ? ' memories-tree-leaf-active' : ''}`}
                onClick={() =>
                  onSelect({
                    kind: 'summary',
                    scope: tree.scope,
                    id: tree.id,
                    label: `${tree.label} · summary`,
                  })
                }
              >
                <span aria-hidden>📝</span> summary
              </button>
            </li>
          )}
          {tree.days.map((day) => {
            const daySelected =
              selected?.kind === 'day' &&
              selected.scope === tree.scope &&
              selected.id === tree.id &&
              selected.day === day;
            return (
              <li key={day}>
                <button
                  type="button"
                  className={`memories-tree-leaf${daySelected ? ' memories-tree-leaf-active' : ''}`}
                  onClick={() =>
                    onSelect({
                      kind: 'day',
                      scope: tree.scope,
                      id: tree.id,
                      day,
                      label: `${tree.label} · ${day}`,
                    })
                  }
                >
                  <span aria-hidden>📅</span> {day}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
