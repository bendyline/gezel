import type {
  Craftbook,
  CraftbookStep,
  GezelSummary,
  UpdateTaskStepRequest,
} from '@bendyline/gezel';
import {
  applyStepPatch,
  removeStepAndCleanEdges,
  reorderStepsArray,
  uniqueStepId,
} from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { CraftbookChatPane } from '../components/CraftbookChatPane.js';
import { CraftbookStepPanel } from '../components/CraftbookStepPanel.js';
import { MarkdownField } from '../components/MarkdownField.js';
import { StepTracker } from '../components/StepTracker.js';
import type { RecentTabInput } from '../components/recent-tabs.js';
import { Tabs } from '../primitives/index.js';

type Source = 'bundled' | 'local' | 'project';

interface CraftbookEditorProps {
  craftbookId: string;
  source?: Source;
  /** Notifies the parent (list view) that the craftbook changed, so it can refresh. */
  onChanged?: () => void;
}

function openTab(input: RecentTabInput) {
  window.dispatchEvent(new CustomEvent('gezel:open-tab', { detail: input }));
}

/** PATCH body that replaces the whole book (the editor holds the full draft). */
function toUpdateBody(book: Craftbook) {
  return {
    name: book.name,
    description: book.description ?? null,
    plan: book.plan ?? null,
    defaultAssignee: book.defaultAssignee ?? null,
    steps: book.steps,
    entryStepId: book.entryStepId,
  };
}

/**
 * The craftbook editor — the design-mode sibling of `TaskDetail`. Header +
 * shared StepTracker (reorderable, no lifecycle status) + per-step panel +
 * an AI-assist tab. Local craftbooks are editable; bundled/project books
 * render read-only with a "Copy to edit" affordance (the PATCH route
 * refuses non-local books anyway).
 */
export function CraftbookEditor({ craftbookId, source, onChanged }: CraftbookEditorProps) {
  const [book, setBook] = useState<Craftbook | null>(null);
  const [resolvedSource, setResolvedSource] = useState<Source>(source ?? 'local');
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [tab, setTab] = useState<'editor' | 'chat'>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameDraft = useRef('');
  const descDraft = useRef('');

  const readOnly = resolvedSource !== 'local';

  const load = useCallback(async () => {
    try {
      const res = await api.getCraftbook(craftbookId, source ? { source } : {});
      setBook(res.craftbook);
      nameDraft.current = res.craftbook.name;
      descDraft.current = res.craftbook.description ?? '';
      setSelectedStepId((prev) =>
        prev && res.craftbook.steps.some((s) => s.id === prev)
          ? prev
          : (res.craftbook.entryStepId ?? res.craftbook.steps[0]?.id ?? null),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, [craftbookId, source]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .listGezels()
      .then((r) => setGezels(r.gezels))
      .catch(() => {});
  }, []);

  // Best-effort: learn the real source (the list view passes it, but a
  // direct open may not) so read-only mode is correct.
  useEffect(() => {
    if (source) {
      setResolvedSource(source);
      return;
    }
    api
      .listCraftbooks({ source: 'all' })
      .then((r) => {
        const hit = r.craftbooks.find((c) => c.id === craftbookId);
        if (hit) setResolvedSource(hit.source);
      })
      .catch(() => {});
  }, [craftbookId, source]);

  // Live refresh when the AI assist edits the book (dispatched by the chat pane).
  useEffect(() => {
    const onEdited = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      if (!detail?.id || detail.id === craftbookId) void load();
    };
    window.addEventListener('gezel:craftbook-edited', onEdited);
    return () => window.removeEventListener('gezel:craftbook-edited', onEdited);
  }, [craftbookId, load]);

  const persist = useCallback(
    async (next: Craftbook) => {
      setBook(next);
      if (readOnly) return;
      setBusy(true);
      setError(null);
      try {
        const res = await api.updateCraftbook(next.id, toUpdateBody(next));
        setBook(res.craftbook);
        onChanged?.();
      } catch (err) {
        setError((err as Error).message);
        await load(); // server rejected the edit — resync to the truth
      } finally {
        setBusy(false);
      }
    },
    [readOnly, onChanged, load],
  );

  if (error && !book) return <p className="error">{error}</p>;
  if (!book) return <p className="placeholder">Loading…</p>;

  const onPatch = (stepId: string, patch: UpdateTaskStepRequest) => {
    void persist({
      ...book,
      steps: book.steps.map((s) => (s.id === stepId ? applyStepPatch(s, patch) : s)),
    });
  };
  const onReorder = (orderedIds: string[]) => {
    void persist({ ...book, steps: reorderStepsArray(book.steps, orderedIds) });
  };
  const onRemove = (stepId: string) => {
    try {
      const steps = removeStepAndCleanEdges(book.steps, stepId);
      const entryStepId = book.entryStepId === stepId ? steps[0]!.id : book.entryStepId;
      if (selectedStepId === stepId) setSelectedStepId(entryStepId);
      void persist({ ...book, steps, entryStepId });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const onSetEntry = (stepId: string) => {
    void persist({ ...book, entryStepId: stepId });
  };
  const onAddStep = () => {
    const id = uniqueStepId(book.steps, 'New step');
    const step: CraftbookStep = { id, name: 'New step' };
    setSelectedStepId(id);
    void persist({ ...book, steps: [...book.steps, step] });
  };

  const saveName = () => {
    const v = nameDraft.current.trim();
    if (!v || v === book.name) return;
    void persist({ ...book, name: v });
  };
  const saveDesc = () => {
    if (descDraft.current === (book.description ?? '')) return;
    void persist({ ...book, description: descDraft.current || undefined });
  };

  const fork = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createCraftbook({
        name: `${book.name} (copy)`,
        ...(book.description ? { description: book.description } : {}),
        ...(book.plan ? { plan: book.plan } : {}),
        steps: book.steps,
        entryStepId: book.entryStepId,
      });
      openTab({ kind: 'craftbook', id: res.craftbook.id, source: 'local' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="craftbook-editor" data-testid="craftbook-editor">
      <header className="craftbook-editor-header">
        <div className="craftbook-editor-title">
          {readOnly ? (
            <h3>{book.name}</h3>
          ) : (
            <input
              className="craftbook-name-input"
              defaultValue={book.name}
              onChange={(e) => {
                nameDraft.current = e.target.value;
              }}
              onBlur={saveName}
              aria-label="Craftbook name"
            />
          )}
          <span className="task-ref">{book.id}</span>
          <span className={`task-badge task-badge-${resolvedSource}`}>{resolvedSource}</span>
          {readOnly && (
            <button type="button" className="primary" onClick={() => void fork()} disabled={busy}>
              Copy to edit
            </button>
          )}
        </div>
        {error && <p className="error small">{error}</p>}
      </header>

      <StepTracker
        steps={book.steps}
        selectedStepId={selectedStepId}
        onSelect={setSelectedStepId}
        entryStepId={book.entryStepId}
        busy={busy}
        ariaLabel="Craftbook steps"
        {...(readOnly ? {} : { onAddStep, onReorder })}
      />

      <CraftbookStepPanel
        craftbookId={book.id}
        steps={book.steps}
        stepId={selectedStepId}
        entryStepId={book.entryStepId}
        gezels={gezels}
        readOnly={readOnly}
        busy={busy}
        onPatch={onPatch}
        onRemove={onRemove}
        onSetEntry={onSetEntry}
      />

      <div className="craftbook-editor-tabs">
        <Tabs.Root value={tab} onValueChange={(v) => setTab(v as 'editor' | 'chat')}>
          <Tabs.List>
            <Tabs.Trigger value="editor">Overview</Tabs.Trigger>
            <Tabs.Trigger value="chat">AI assist</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
      </div>

      {tab === 'editor' && (
        <div className="craftbook-overview">
          <div className="task-step-field full-width">
            <span className="task-step-field-label">Description</span>
            <MarkdownField
              key={`cbdesc-${book.id}`}
              value={book.description ?? ''}
              readOnly={readOnly}
              placeholder="What this craftbook is for and when to reach for it."
              onCommit={(md) => {
                descDraft.current = md;
                saveDesc();
              }}
            />
          </div>
          {book.plan && (
            <div className="task-step-field full-width">
              <span className="task-step-field-label">Plan</span>
              <p className="muted small">{book.plan}</p>
            </div>
          )}
        </div>
      )}

      {tab === 'chat' && (
        <CraftbookChatPane craftbookId={book.id} craftbookName={book.name} readOnly={readOnly} />
      )}
    </div>
  );
}
