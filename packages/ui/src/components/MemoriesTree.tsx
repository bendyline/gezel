import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { AutosaveStatus } from './AutosaveStatus.js';

type GezelSelectedNode =
  | { kind: 'summary'; label: string }
  | { kind: 'lessons'; label: string }
  | { kind: 'day'; day: string; label: string };

interface GezelMemoryTree {
  summary: string | null;
  lessons: string | null;
  days: string[];
  expanded: boolean;
}

/**
 * Read-only browser for memories owned by one gezel. Project memory is kept
 * out of this character-level surface and is shown in that project's Settings
 * page instead.
 */
export function MemoriesTree({
  gezelId,
  gezelName,
}: {
  gezelId: string;
  gezelName: string;
}) {
  const [tree, setTree] = useState<GezelMemoryTree | null>(null);
  const [selected, setSelected] = useState<GezelSelectedNode | null>(null);
  const [preview, setPreview] = useState<{
    loading: boolean;
    content: string | null;
    error: string | null;
  }>({ loading: false, content: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setSelected(null);
    void (async () => {
      const [days, summary, lessons] = await Promise.all([
        api
          .listMemoryDays('gezel', gezelId)
          .then((result) => result.days)
          .catch(() => [] as string[]),
        api
          .readMemorySummary('gezel', gezelId)
          .then((result) => result.content)
          .catch(() => ''),
        api
          .readMemoryLessons(gezelId)
          .then((result) => result.content)
          .catch(() => ''),
      ]);
      if (!cancelled) {
        setTree({ days, summary: summary || null, lessons: lessons || null, expanded: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gezelId]);

  useEffect(() => {
    if (!selected) {
      setPreview({ loading: false, content: null, error: null });
      return;
    }
    let cancelled = false;
    setPreview({ loading: true, content: null, error: null });
    void (async () => {
      try {
        const result =
          selected.kind === 'summary'
            ? await api.readMemorySummary('gezel', gezelId)
            : selected.kind === 'lessons'
              ? await api.readMemoryLessons(gezelId)
              : await api.readMemoryDay('gezel', gezelId, selected.day);
        if (!cancelled) {
          setPreview({ loading: false, content: result.content, error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setPreview({
            loading: false,
            content: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gezelId, selected]);

  const toggleExpand = useCallback(() => {
    setTree((current) => (current ? { ...current, expanded: !current.expanded } : current));
  }, []);

  if (tree === null) {
    return <p className="muted small">Loading memories…</p>;
  }
  if (tree.days.length === 0 && !tree.summary && !tree.lessons) {
    return (
      <p className="placeholder">
        No memories yet. This gezel will build an individual memory over time as you work together.
      </p>
    );
  }

  return (
    <div className="memories-pane" data-testid="memories-tree">
      <div className="memories-tree" role="tree">
        <p className="memories-tree-total muted small">
          {tree.days.length} day{tree.days.length === 1 ? '' : 's'} of individual memories.
        </p>
        <GezelTreeNode
          gezelName={gezelName}
          tree={tree}
          onToggle={toggleExpand}
          onSelect={setSelected}
          selected={selected}
        />
      </div>
      <MemoryPreview selected={selected} preview={preview} />
    </div>
  );
}

function GezelTreeNode({
  gezelName,
  tree,
  onToggle,
  onSelect,
  selected,
}: {
  gezelName: string;
  tree: GezelMemoryTree;
  onToggle: () => void;
  onSelect: (node: GezelSelectedNode) => void;
  selected: GezelSelectedNode | null;
}) {
  return (
    <div className="memories-tree-scope" role="treeitem" aria-expanded={tree.expanded}>
      <button type="button" className="memories-tree-scope-header" onClick={onToggle}>
        <span className="memories-tree-caret" aria-hidden>
          {tree.expanded ? '▾' : '▸'}
        </span>
        <span className="memories-tree-scope-label">{gezelName}</span>
        <span className="muted small">
          {tree.days.length} day{tree.days.length === 1 ? '' : 's'}
          {tree.lessons ? ' + lessons' : ''}
          {tree.summary ? ' + summary' : ''}
        </span>
      </button>
      {tree.expanded && (
        <ul className="memories-tree-children">
          {tree.lessons && (
            <MemoryLeaf
              active={selected?.kind === 'lessons'}
              label="lessons"
              onClick={() => onSelect({ kind: 'lessons', label: `${gezelName} · lessons` })}
            />
          )}
          {tree.summary && (
            <MemoryLeaf
              active={selected?.kind === 'summary'}
              label="summary"
              onClick={() => onSelect({ kind: 'summary', label: `${gezelName} · summary` })}
            />
          )}
          {tree.days.map((day) => (
            <MemoryLeaf
              key={day}
              active={selected?.kind === 'day' && selected.day === day}
              label={day}
              onClick={() => onSelect({ kind: 'day', day, label: `${gezelName} · ${day}` })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryLeaf({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`memories-tree-leaf${active ? ' memories-tree-leaf-active' : ''}`}
        onClick={onClick}
      >
        {label}
      </button>
    </li>
  );
}

function MemoryPreview({
  selected,
  preview,
}: {
  selected: GezelSelectedNode | null;
  preview: { loading: boolean; content: string | null; error: string | null };
}) {
  return (
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
        <p className="placeholder">Select a day or lesson on the left to view its contents.</p>
      )}
    </div>
  );
}

/** Editable project-owned memory files for the Project Settings page. */
export function ProjectMemoriesEditor({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [days, setDays] = useState<string[] | null>(null);
  const [daysError, setDaysError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayContent, setDayContent] = useState<{
    day: string;
    loading: boolean;
    content: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDays(null);
    setDaysError(null);
    setSelectedDay(null);
    setDayContent(null);
    void api
      .listMemoryDays('project', projectId)
      .then((result) => {
        if (cancelled) return;
        setDays(result.days);
        setSelectedDay(result.days[0] ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDays([]);
          setDaysError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!selectedDay) {
      setDayContent(null);
      return;
    }
    let cancelled = false;
    const day = selectedDay;
    setDayContent({ day, loading: true, content: null, error: null });
    void api
      .readMemoryDay('project', projectId, day)
      .then((result) => {
        if (!cancelled)
          setDayContent({ day, loading: false, content: result.content, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDayContent({
            day,
            loading: false,
            content: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedDay]);

  return (
    <section id="project-about-memories" className="project-about-section project-about-anchor">
      <h3 className="project-about-section-title">Project memories</h3>
      <p className="muted small project-memories-hint">
        Notes shared by every gezel working in this project. Changes are saved to the project’s
        memory files and used in future recall.
      </p>
      {days === null ? (
        <p className="muted small">Loading memories…</p>
      ) : daysError ? (
        <p className="error">{daysError}</p>
      ) : days.length === 0 ? (
        <p className="placeholder">
          No project memories yet. Gezels add shared notes here as work progresses.
        </p>
      ) : (
        <div className="project-memories-browser">
          <div className="memories-tree project-memories-days">
            <p className="memories-tree-total muted small">
              {days.length} day{days.length === 1 ? '' : 's'}
            </p>
            <ul className="memories-tree-children project-memories-day-list">
              {days.map((day) => (
                <MemoryLeaf
                  key={day}
                  active={selectedDay === day}
                  label={day}
                  onClick={() => setSelectedDay(day)}
                />
              ))}
            </ul>
          </div>
          <div className="project-memory-editor">
            {dayContent?.loading && <p className="muted small">Loading…</p>}
            {dayContent?.error && <p className="error">{dayContent.error}</p>}
            {dayContent?.content !== null &&
              dayContent &&
              !dayContent.loading &&
              !dayContent.error && (
                <ProjectMemoryDayEditor
                  key={`${projectId}:${dayContent.day}`}
                  projectId={projectId}
                  projectName={projectName}
                  day={dayContent.day}
                  initial={dayContent.content}
                />
              )}
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectMemoryDayEditor({
  projectId,
  projectName,
  day,
  initial,
}: {
  projectId: string;
  projectName: string;
  day: string;
  initial: string;
}) {
  const autosave = useSerializedAutosave({
    resourceKey: `project:${projectId}:memory:${day}`,
    initialValue: initial,
    save: (content) => api.updateMemoryDay('project', projectId, day, content),
  });

  return (
    <>
      <div className="project-memory-editor-heading">
        <code>
          {projectName} · {day}
        </code>
      </div>
      <div className="project-memory-source-editor">
        <textarea
          className="project-memory-source"
          aria-label={`${projectName} memory for ${day}`}
          value={autosave.desiredValue()}
          onChange={(event) => autosave.update(event.target.value)}
          spellCheck={false}
        />
        <div className="project-memory-source-status">
          <span>Memory markdown</span>
          <AutosaveStatus autosave={autosave} />
        </div>
      </div>
    </>
  );
}
