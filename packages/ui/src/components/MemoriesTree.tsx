import { type MemoryScope, USER_MEMORY_ID } from '@bendyline/gezel-client';
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
  days: string[];
  expanded: boolean;
}

const PINNED_HINT =
  'Lines under a “## Pinned” heading are kept exactly as written; the rest is refreshed from new notes.';

/**
 * The memories one gezel owns: its daily notes and its lessons, each editable
 * in place. Project memory is kept out of this character-level surface and is
 * shown in that project's Settings page; what the crew knows about the person
 * is in Settings → About you.
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
      const [days, summary] = await Promise.all([
        api
          .listMemoryDays('gezel', gezelId)
          .then((result) => result.days)
          .catch(() => [] as string[]),
        api
          .readMemorySummary('gezel', gezelId)
          .then((result) => result.content)
          .catch(() => ''),
      ]);
      if (!cancelled) setTree({ days, summary: summary || null, expanded: true });
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
    return null;
  }

  return (
    <>
      {tree.days.length === 0 && (
        <p className="placeholder">
          No notes yet. This gezel builds a memory as you work together, and you can write its
          lessons yourself.
        </p>
      )}
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
        <div className="memories-preview">
          {!selected ? (
            <p className="placeholder">Select a day or the lessons to read and edit them.</p>
          ) : preview.error ? (
            <p className="error">{preview.error}</p>
          ) : preview.content === null || preview.loading ? null : selected.kind === 'summary' ? (
            <>
              <header className="memories-preview-header">
                <code>{selected.label}</code>
              </header>
              <pre className="memories-preview-body">{preview.content || '(empty)'}</pre>
            </>
          ) : (
            <MemoryTextEditor
              key={`${gezelId}:${selected.kind === 'day' ? selected.day : 'lessons'}`}
              resourceKey={`gezel:${gezelId}:memory:${selected.kind === 'day' ? selected.day : 'lessons'}`}
              heading={selected.label}
              label={
                selected.kind === 'day'
                  ? `${gezelName} memory for ${selected.day}`
                  : `${gezelName} lessons`
              }
              initial={preview.content}
              save={(content) =>
                selected.kind === 'day'
                  ? api.updateMemoryDay('gezel', gezelId, selected.day, content)
                  : api.writeMemoryLessons(gezelId, content)
              }
              statusLabel={selected.kind === 'day' ? 'Memory markdown' : PINNED_HINT}
            />
          )}
        </div>
      </div>
    </>
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
          {tree.days.length} day{tree.days.length === 1 ? '' : 's'} + lessons
          {tree.summary ? ' + summary' : ''}
        </span>
      </button>
      {tree.expanded && (
        <ul className="memories-tree-children">
          <MemoryLeaf
            active={selected?.kind === 'lessons'}
            label="lessons"
            onClick={() => onSelect({ kind: 'lessons', label: `${gezelName} · lessons` })}
          />
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

/** Editable project-owned memory files for the Project Settings page. */
export function ProjectMemoriesEditor({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  return (
    <MemoryDaysEditor
      scope="project"
      id={projectId}
      ownerName={projectName}
      sectionId="project-about-memories"
      sectionClassName="project-about-section project-about-anchor"
      title="Project memories"
      hint="Notes shared by every gezel working in this project. Changes are saved to the project’s memory files and used in future recall."
      emptyText="No project memories yet. Gezels add shared notes here as work progresses."
    />
  );
}

/** What the crew has learned about the person, shared by every gezel. */
export function UserMemoriesEditor() {
  return (
    <MemoryDaysEditor
      scope="user"
      id={USER_MEMORY_ID}
      ownerName="About you"
      sectionId="settings-about-you"
      title="About you"
      hint="What your gezels have learned about you, shared by all of them. Correct or remove anything here; gezels read the new version from their next message."
      emptyText="Nothing yet. As you work together, gezels note what they learn about you here."
    />
  );
}

/** One scope's daily memory files: a day list beside an autosaving editor. */
function MemoryDaysEditor({
  scope,
  id,
  ownerName,
  sectionId,
  sectionClassName,
  title,
  hint,
  emptyText,
}: {
  scope: MemoryScope;
  id: string;
  ownerName: string;
  sectionId: string;
  sectionClassName?: string;
  title: string;
  hint: string;
  emptyText: string;
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
      .listMemoryDays(scope, id)
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
  }, [scope, id]);

  useEffect(() => {
    if (!selectedDay) {
      setDayContent(null);
      return;
    }
    let cancelled = false;
    const day = selectedDay;
    setDayContent({ day, loading: true, content: null, error: null });
    void api
      .readMemoryDay(scope, id, day)
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
  }, [scope, id, selectedDay]);

  return (
    <section id={sectionId} className={sectionClassName}>
      <h3 className="project-about-section-title">{title}</h3>
      <p className="muted small project-memories-hint">{hint}</p>
      {days === null ? null : daysError ? (
        <p className="error">{daysError}</p>
      ) : days.length === 0 ? (
        <p className="placeholder">{emptyText}</p>
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
            {dayContent?.error && <p className="error">{dayContent.error}</p>}
            {dayContent?.content !== null &&
              dayContent &&
              !dayContent.loading &&
              !dayContent.error && (
                <MemoryTextEditor
                  key={`${scope}:${id}:${dayContent.day}`}
                  resourceKey={`${scope}:${id}:memory:${dayContent.day}`}
                  heading={`${ownerName} · ${dayContent.day}`}
                  label={`${ownerName} memory for ${dayContent.day}`}
                  initial={dayContent.content}
                  save={(content) => api.updateMemoryDay(scope, id, dayContent.day, content)}
                  statusLabel="Memory markdown"
                />
              )}
          </div>
        </div>
      )}
    </section>
  );
}

/** One memory file edited in place; it autosaves, with the state in its status bar. */
function MemoryTextEditor({
  resourceKey,
  heading,
  label,
  initial,
  save,
  statusLabel,
}: {
  resourceKey: string;
  heading: string;
  label: string;
  initial: string;
  save: (content: string) => Promise<unknown>;
  statusLabel: string;
}) {
  const autosave = useSerializedAutosave({ resourceKey, initialValue: initial, save });

  return (
    <>
      <div className="project-memory-editor-heading">
        <code>{heading}</code>
      </div>
      <div className="project-memory-source-editor">
        <textarea
          className="project-memory-source"
          aria-label={label}
          value={autosave.desiredValue()}
          onChange={(event) => autosave.update(event.target.value)}
          spellCheck={false}
        />
        <div className="project-memory-source-status">
          <span>{statusLabel}</span>
          <AutosaveStatus autosave={autosave} />
        </div>
      </div>
    </>
  );
}
