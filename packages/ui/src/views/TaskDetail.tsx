import type {
  ChatSessionSummary,
  CompleteStepGateInfo,
  GezelSummary,
  Outcome,
  Task,
  TaskAssignee,
  TaskNote,
  TaskStatus,
  UpdateTaskStepRequest,
} from '@bendyline/gezel';
import { planGuardrails, summarizePlanDocument } from '@bendyline/gezel';
import { EditorShell } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { AutosaveStatus } from '../components/AutosaveStatus.js';
import { GezelIcon } from '../components/GezelIcon.js';
import { PromptDialog } from '../components/PromptDialog.js';
import { TaskChatPane } from '../components/TaskChatPane.js';
import { TaskStatusKeys } from '../components/TaskStatusKeys.js';
import { TaskStepPanel } from '../components/TaskStepPanel.js';
import { TaskStepTracker } from '../components/TaskStepTracker.js';
import { TransformToolbarButton } from '../components/transform/TransformToolbarButton.js';
import { useSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { Select } from '../primitives/index.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { useEffectiveTheme } from '../theme.js';

type CronOverlap = 'skip' | 'queue' | 'concurrent';

/* A service-run job is only ever held or let run — it can't be marked done or
   canceled by hand, since the schedule decides when it next fires. */
const SYSTEM_JOB_STATUS_VALUES: Array<Exclude<TaskStatus, 'draft'>> = ['active', 'paused'];

/**
 * Editor for a task's outcomes — the prose statements of what should be
 * created or updated at success. Shown on drafts (where the plan is being
 * shaped) and on any task that already has outcomes. Save-on-button, with a
 * re-sync when the underlying task's outcomes change (e.g. the planner edits
 * them from chat).
 */
function OutcomesEditor({
  outcomes,
  busy,
  showGuards,
  guards,
  onSave,
}: {
  outcomes: Outcome[];
  busy: boolean;
  showGuards: boolean;
  guards: string[];
  onSave: (outcomes: Outcome[]) => void | Promise<void>;
}) {
  const [rows, setRows] = useState<Outcome[]>(outcomes);
  const sig = outcomes.map((o) => `${o.id}:${o.text}:${o.met ? 1 : 0}`).join('|');
  const lastSig = useRef(sig);
  useEffect(() => {
    if (lastSig.current !== sig) {
      lastSig.current = sig;
      setRows(outcomes);
    }
  }, [sig, outcomes]);

  const dirty =
    rows.length !== outcomes.length ||
    rows.some((r, i) => r.text !== outcomes[i]?.text || r.id !== outcomes[i]?.id);

  return (
    <section className="task-outcomes-section">
      <div className="task-description-header">
        <h4>Outcomes</h4>
        <div className="task-description-actions">
          <button
            type="button"
            onClick={() => setRows((prev) => [...prev, { id: `o${prev.length + 1}`, text: '' }])}
            disabled={busy}
          >
            + Add
          </button>
          <button type="button" onClick={() => void onSave(rows)} disabled={busy || !dirty}>
            Save
          </button>
        </div>
      </div>
      {showGuards && guards.length > 0 && (
        <p className="muted small">⚠️ Before running: {guards.join('; ')}.</p>
      )}
      <p className="muted small">
        What should be created or updated at success — checked by the final verification step.
      </p>
      <ul className="task-outcomes-list">
        {rows.length === 0 && (
          <li className="muted small">No outcomes yet. Add 3–8 concrete, verifiable results.</li>
        )}
        {rows.map((o, i) => (
          <li key={o.id} className="task-outcome-row">
            <span className="task-outcome-check" title={o.met ? 'verified' : 'not verified'}>
              {o.met ? '✓' : '○'}
            </span>
            <input
              type="text"
              className="task-outcome-input"
              value={o.text}
              placeholder="An index.html with a playable game and a game-over screen"
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((r, j) => (j === i ? { ...r, text: e.target.value } : r)),
                )
              }
              disabled={busy}
            />
            <button
              type="button"
              className="subtle"
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              disabled={busy}
              aria-label="Remove outcome"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TaskDetail({
  task,
  gezels,
  projectName,
  onChanged,
}: {
  task: Task;
  gezels: GezelSummary[];
  projectName: string;
  onChanged: (t: Task) => void | Promise<void>;
}) {
  const editorTheme = useEffectiveTheme();
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [notesStatus, setNotesStatus] = useState<string>('');
  const [composerKey, setComposerKey] = useState(0);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [children, setChildren] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The latest completion-gate rejection, rendered inline on the step
  // panel with a user-only "Complete anyway" escape hatch.
  const [gateRejection, setGateRejection] = useState<
    (CompleteStepGateInfo & { stepId: string }) | null
  >(null);
  const [addStepOpen, setAddStepOpen] = useState(false);
  const [tab, setTab] = useState<'task' | 'chat'>('task');
  // Task / Chat / each bench step form one mutually-exclusive tab set. A task
  // opens on the Task overview (no step selected); clicking a bench step opens
  // its panel, and clicking Task/Chat deselects the step again. `null` means a
  // task-wide view (Task or Chat) is showing.
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const handleSelectStep = useCallback((stepId: string) => {
    setSelectedStepId(stepId);
  }, []);
  const handleSelectTab = useCallback((next: 'task' | 'chat') => {
    setSelectedStepId(null);
    setTab(next);
  }, []);
  // Follow the cursor: when we're viewing the step that was active and it
  // advances (e.g. after a Complete), move the selection along with it. Never
  // steals focus while on the Task/Chat views (no step selected).
  const prevActiveStep = useRef(task.activeStepId ?? null);
  useEffect(() => {
    const wasActive = prevActiveStep.current;
    prevActiveStep.current = task.activeStepId ?? null;
    if (task.activeStepId && task.activeStepId !== wasActive) {
      const nextActive = task.activeStepId;
      setSelectedStepId((prev) => (prev !== null && prev === wasActive ? nextActive : prev));
    }
  }, [task.activeStepId]);
  const composerDraft = useRef<string>('');
  // Description body is the long-form prose persisted as `about.md` sidecar
  // to the task; the server hydrates it onto `task.description`. It autosaves
  // like every other long-form editor in the app (gezel about.md, project
  // about/mission, documents). It used to carry a Save button and a draft ref
  // whose comment claimed a blur flush — there was no blur handler anywhere,
  // so the panel unmounting on a tab switch or a step selection discarded the
  // edit silently.
  const [descriptionKey, setDescriptionKey] = useState(0);

  const saveDescription = useCallback(
    (next: string) => api.updateTask(task.projectId, task.num, { description: next }),
    [task.projectId, task.num],
  );
  const descriptionAutosave = useSerializedAutosave({
    resourceKey: `task:${task.ref}:description`,
    initialValue: task.description ?? '',
    save: saveDescription,
    onLatestSaved: (updated) => {
      void onChanged(updated);
    },
  });
  // Reset the editor + draft whenever the underlying task body changes
  // (e.g. another tab/MCP tool updated it). EditorShell only reads
  // `initialMarkdown` once per mount, so we bump the key to force it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: descriptionKey is the reset target, not a dep.
  useEffect(() => {
    // hydrate() keeps an in-flight local edit from being clobbered by the
    // server copy it is about to replace; it returns the value the editor
    // should actually show.
    descriptionAutosave.hydrate(task.description ?? '');
    setDescriptionKey((k) => k + 1);
  }, [task.ref, task.description, descriptionAutosave.hydrate]);

  const loadNotes = useCallback(async () => {
    const r = await api.listTaskNotes(task.projectId, task.num);
    setNotes(r.notes);
  }, [task.projectId, task.num]);

  const loadSessions = useCallback(async () => {
    const r = await api.listTaskSessions(task.projectId, task.num);
    setSessions(r.sessions);
  }, [task.projectId, task.num]);

  const loadChildren = useCallback(async () => {
    // Only meaningful for parents with a template — skip the extra round
    // trip for regular tasks.
    if (!task.spawnsCraftbook) {
      setChildren([]);
      return;
    }
    try {
      const r = await api.listTaskChildren(task.projectId, task.num);
      setChildren(r.tasks);
    } catch {
      setChildren([]);
    }
  }, [task.projectId, task.num, task.spawnsCraftbook]);

  useEffect(() => {
    void loadNotes();
    void loadSessions();
    void loadChildren();
  }, [loadNotes, loadSessions, loadChildren]);

  const postNote = useCallback(async () => {
    const text = composerDraft.current.trim();
    if (!text) return;
    setNotesStatus('posting…');
    try {
      const stepId = task.activeStepId;
      const r = await api.appendTaskNote(task.projectId, task.num, {
        text,
        ...(stepId ? { stepId } : {}),
      });
      setNotes((prev) => [r.note, ...prev]);
      composerDraft.current = '';
      setComposerKey((k) => k + 1);
      setNotesStatus('posted');
    } catch (err) {
      setNotesStatus(`post failed: ${(err as Error).message}`);
    }
  }, [task.projectId, task.num, task.activeStepId]);

  const removeNote = useCallback(
    async (noteId: string) => {
      setNotesStatus('removing…');
      try {
        await api.deleteTaskNote(task.projectId, task.num, noteId);
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
        setNotesStatus('removed');
      } catch (err) {
        setNotesStatus(`remove failed: ${(err as Error).message}`);
      }
    },
    [task.projectId, task.num],
  );

  // Per-note edit state. Only one note may be in edit mode at a time —
  // the pencil button on a note swaps that note's read-only EditorShell
  // for an editable one. Drafts live in a ref so keystrokes don't
  // re-render the whole feed.
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const editDraftRef = useRef<string>('');
  const beginEdit = useCallback((note: TaskNote) => {
    editDraftRef.current = note.text;
    setEditingNoteId(note.id);
  }, []);
  const cancelEdit = useCallback(() => {
    setEditingNoteId(null);
    editDraftRef.current = '';
  }, []);
  const saveEdit = useCallback(
    async (noteId: string) => {
      const text = editDraftRef.current.trim();
      if (!text) return;
      setNotesStatus('saving…');
      try {
        const r = await api.updateTaskNote(task.projectId, task.num, noteId, { text });
        setNotes((prev) => prev.map((n) => (n.id === noteId ? r.note : n)));
        setNotesStatus('saved');
        setEditingNoteId(null);
        editDraftRef.current = '';
      } catch (err) {
        setNotesStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [task.projectId, task.num],
  );

  const setStatus = async (status: TaskStatus) => {
    setBusy(true);
    try {
      const updated = await api.setTaskStatus(task.projectId, task.num, status);
      await onChanged(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activate = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.activateTask(task.projectId, task.num, force);
      await onChanged(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveOutcomes = async (outcomes: Outcome[]) => {
    setBusy(true);
    setError(null);
    try {
      const cleaned = outcomes.filter((o) => o.text.trim().length > 0);
      const updated = await api.updateTask(task.projectId, task.num, {
        outcomes: cleaned.length > 0 ? cleaned : null,
      });
      await onChanged(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setAssignee = async (assignee: TaskAssignee) => {
    setBusy(true);
    try {
      const updated = await api.setTaskAssignee(task.projectId, task.num, assignee);
      await onChanged(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activateStep = async (stepId: string) => {
    setBusy(true);
    try {
      const updated = await api.activateTaskStep(task.projectId, task.num, stepId);
      await onChanged(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const completeStep = async (stepId: string, force = false) => {
    setBusy(true);
    try {
      const res = await api.completeTaskStep(
        task.projectId,
        task.num,
        stepId,
        force ? { force: true } : {},
      );
      // A gate rejection is a structured result, not an error: the step
      // stays active and the prescriptive message renders inline with a
      // user-only "Complete anyway" escape hatch.
      setGateRejection(res.gate ? { stepId, ...res.gate } : null);
      await onChanged(res.task);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const updateStep = async (stepId: string, patch: UpdateTaskStepRequest) => {
    setBusy(true);
    try {
      const r = await api.updateTaskStep(task.projectId, task.num, stepId, patch);
      await onChanged(r.task);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addStep = async (name: string) => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const updated = await api.addTaskStep(task.projectId, task.num, {
        name: name.trim(),
      });
      await onChanged(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const spawnInstance = async () => {
    if (!task.spawnsCraftbook) return;
    setBusy(true);
    setError(null);
    try {
      await api.spawnTaskInstances(task.projectId, task.num, { count: 1 });
      await loadChildren();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setCronOverlap = async (overlap: CronOverlap) => {
    if (!task.cron) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateTask(task.projectId, task.num, {
        cron: { expression: task.cron.expression, overlap },
      });
      await onChanged(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const gezelName = (id?: string) => {
    if (!id) return '';
    const g = gezels.find((g) => g.id === id);
    return g?.name ?? id;
  };

  // A draft whose main craftbook came from the catalog is a curated
  // recipe, not a hand-authored plan — mirror `TaskManager.activate` and
  // skip the plan-readiness guardrails, and speak in the launcher's
  // language ("fire") instead of the plan-approval flow's.
  const curatedBook = !!task.sourceCraftbookIds?.some((s) => s.role === 'main');
  const systemOwnerId =
    task.origin?.kind === 'system-job' ? task.origin.managedByGezelId : undefined;
  const isSystemJob = task.origin?.kind === 'system-job';
  const systemOwner = systemOwnerId
    ? gezels.find((gezel) => gezel.id === systemOwnerId)
    : undefined;
  const planGuards =
    task.status === 'draft' && !curatedBook ? planGuardrails(summarizePlanDocument(task)) : [];

  return (
    <div className="task-detail" data-testid="task-detail">
      <header className="task-detail-header">
        <div>
          <span className="task-detail-ref">{task.ref}</span>
          {projectName && <span className="task-detail-project">{projectName}</span>}
          <h3>{task.title}</h3>
        </div>
        <div className="task-detail-actions">
          {task.status === 'draft' ? (
            <div className="task-draft-activate">
              <span className="task-detail-status-badge status-draft">
                {curatedBook ? 'ready' : 'draft'}
              </span>
              <button
                type="button"
                className="primary"
                disabled={busy}
                title={
                  planGuards.length > 0 ? `Before running: ${planGuards.join('; ')}` : undefined
                }
                onClick={() => void activate(planGuards.length > 0)}
              >
                {busy ? 'Firing…' : planGuards.length > 0 ? 'Fire anyway' : 'Fire task'}
              </button>
              <button
                type="button"
                className="subtle"
                disabled={busy}
                onClick={() => void setStatus('canceled')}
              >
                Discard
              </button>
            </div>
          ) : (
            <TaskStatusKeys
              value={task.status}
              options={isSystemJob ? SYSTEM_JOB_STATUS_VALUES : undefined}
              disabled={busy}
              onChange={(status) => void setStatus(status)}
            />
          )}
          {isSystemJob ? (
            <div
              className="task-system-owner"
              title="This gezel manages a service-run job. It does not open a duplicate chat turn."
            >
              {systemOwner && (
                <GezelIcon
                  svg={systemOwner.icon ?? null}
                  poppetje={systemOwner.poppetje}
                  iconOverride={systemOwner.iconOverride}
                  name={systemOwner.name}
                  size={22}
                />
              )}
              <span>
                {systemOwner?.name ?? 'Boekwachter'} <small>· system-run</small>
              </span>
            </div>
          ) : (
            <Select.Root
              value={task.assignee.kind === 'user' ? '__user' : task.assignee.gezelId}
              disabled={busy}
              onValueChange={(v) => {
                void setAssignee(v === '__user' ? { kind: 'user' } : { kind: 'gezel', gezelId: v });
              }}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="__user">→ You</Select.Item>
                {gezels.map((g) => (
                  <Select.Item key={g.id} value={g.id}>
                    → {g.name}
                    {g.role ? ` (${g.role})` : ''}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
        </div>
      </header>

      <div
        className={`task-bench-row${
          selectedStepId !== null || tab === 'task' ? ' has-docked-panel' : ''
        }${selectedStepId !== null ? ' has-selected-step' : ''}`}
      >
        <div className="task-tab-rail" role="tablist" aria-label="Task view">
          <button
            type="button"
            role="tab"
            aria-selected={selectedStepId === null && tab === 'task'}
            className={`task-tab-btn${selectedStepId === null && tab === 'task' ? ' active' : ''}`}
            onClick={() => handleSelectTab('task')}
          >
            Task
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedStepId === null && tab === 'chat'}
            className={`task-tab-btn${selectedStepId === null && tab === 'chat' ? ' active' : ''}`}
            onClick={() => handleSelectTab('chat')}
          >
            Chat{sessions.length > 0 ? ` (${sessions.length})` : ''}
          </button>
        </div>
        <TaskStepTracker
          steps={task.craftbook.steps}
          {...(task.activeStepId ? { activeStepId: task.activeStepId } : {})}
          selectedStepId={selectedStepId}
          onSelect={handleSelectStep}
          onAddStep={() => setAddStepOpen(true)}
          busy={busy || isSystemJob}
          gezels={gezels}
          taskStatus={task.status}
          onAssign={(stepId, assignee) => void updateStep(stepId, { assignee })}
          taskAssignee={systemOwnerId ? { kind: 'gezel', gezelId: systemOwnerId } : task.assignee}
        />
      </div>

      {selectedStepId !== null && (
        <TaskStepPanel
          task={task}
          stepId={selectedStepId}
          gezels={gezels}
          busy={busy || isSystemJob}
          gateRejection={gateRejection}
          onActivate={activateStep}
          onComplete={completeStep}
          onForceComplete={(stepId) => completeStep(stepId, true)}
          onPatch={updateStep}
        />
      )}

      {selectedStepId === null && tab === 'chat' && <TaskChatPane task={task} gezels={gezels} />}

      {selectedStepId === null && tab === 'task' && (
        <div className="task-view-panel">
          <section className="task-description-section">
            <div className="task-description-header">
              <h4>Description</h4>
            </div>
            <div className="task-description-editor">
              <EditorShell
                key={`description-${task.ref}-${descriptionKey}`}
                initialMarkdown={task.description ?? ''}
                onChange={(source) => descriptionAutosave.update(source)}
                colorScheme={editorTheme}
                showPlayTab={false}
                height="auto"
                minHeight="180px"
                maxHeight="480px"
                fullWidth
                toolbarSlotAfterActions={
                  <TransformToolbarButton
                    context="task-description"
                    subject={task.title}
                    parentContext={`Project: ${projectName}`}
                  />
                }
                statusBarSlotRight={<AutosaveStatus autosave={descriptionAutosave} />}
              />
            </div>
          </section>
          {(task.status === 'draft' || (task.outcomes && task.outcomes.length > 0)) && (
            <OutcomesEditor
              key={`outcomes-${task.ref}`}
              outcomes={task.outcomes ?? []}
              busy={busy}
              showGuards={task.status === 'draft'}
              guards={planGuards}
              onSave={saveOutcomes}
            />
          )}
          {task.plan && (
            <section className="task-plan">
              <h4>Plan</h4>
              <pre className="task-plan-body">{task.plan}</pre>
            </section>
          )}
          {error && <p className="error">{error}</p>}

          <section className="task-notes">
            <h4>
              Notes <span className="muted small">{notesStatus}</span>
            </h4>
            {/* Composer sits at the top of the feed so a freshly-posted
                note appears immediately below it — reverse-chronological
                from the user's vantage point, no scrolling required. */}
            <div className="task-notes-composer">
              <EditorShell
                key={`composer-${composerKey}`}
                initialMarkdown=""
                placeholder="Write a note — paste markdown, drag in media, or just start typing."
                onChange={(source) => {
                  composerDraft.current = source;
                }}
                colorScheme={editorTheme}
                showPlayTab={false}
                height="160px"
                fullWidth
              />
              <div className="task-notes-composer-actions">
                <button type="button" onClick={() => void postNote()}>
                  Post note
                </button>
              </div>
            </div>
            <ul className="task-notes-feed">
              {notes.length === 0 && (
                <li className="task-notes-empty muted small">
                  No notes yet. Post the first one above — short, dated, attributed.
                </li>
              )}
              {notes.map((n) => {
                const step = n.stepId
                  ? task.craftbook.steps.find((s) => s.id === n.stepId)
                  : undefined;
                const authorLabel = n.author.kind === 'user' ? 'You' : n.author.name;
                const authorGezelId = n.author.kind === 'gezel' ? n.author.gezelId : undefined;
                const authorGezel = authorGezelId
                  ? gezels.find((gezel) => gezel.id === authorGezelId)
                  : undefined;
                const editing = editingNoteId === n.id;
                const cardCls = editing ? 'task-note-card editing' : 'task-note-card read-only';
                return (
                  <li key={n.id} className={cardCls}>
                    <header className="task-note-header">
                      <span className="task-note-author task-note-author-identity">
                        {authorGezel && (
                          <GezelIcon
                            svg={authorGezel.icon ?? null}
                            poppetje={authorGezel.poppetje}
                            iconOverride={authorGezel.iconOverride}
                            name={authorGezel.name}
                            size={22}
                          />
                        )}
                        <span>{authorLabel}</span>
                      </span>
                      <time
                        className="task-note-time muted small"
                        dateTime={n.at}
                        title={formatAbsoluteTime(n.at, n.at)}
                      >
                        {formatRelativeTime(n.at, { fallback: n.at })}
                      </time>
                      {step && (
                        <span className="task-note-step muted small">step: {step.name}</span>
                      )}
                      {!editing && (
                        <button
                          type="button"
                          className="task-note-edit"
                          title="Edit this note"
                          aria-label="Edit note"
                          onClick={() => beginEdit(n)}
                        >
                          {/* Subtle pencil glyph; full-fidelity edit mode
                              swaps the body for an editable EditorShell. */}
                          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                            <path
                              d="M2 13 L2 14 L3 14 L11 6 L10 5 Z M11 4 L12 3 L13 4 L12 5 Z"
                              fill="currentColor"
                            />
                          </svg>
                        </button>
                      )}
                      <button
                        type="button"
                        className="task-note-delete"
                        title="Remove this note"
                        onClick={() => void removeNote(n.id)}
                      >
                        ×
                      </button>
                    </header>
                    <div className="task-note-body">
                      <EditorShell
                        key={editing ? `edit-${n.id}` : n.id}
                        initialMarkdown={n.text}
                        readOnly={!editing}
                        onChange={
                          editing
                            ? (source) => {
                                editDraftRef.current = source;
                              }
                            : undefined
                        }
                        colorScheme={editorTheme}
                        showPlayTab={false}
                        showStatusBar={editing}
                        height="auto"
                        fullWidth
                      />
                    </div>
                    {editing && (
                      <div className="task-note-edit-actions">
                        <button type="button" className="muted" onClick={cancelEdit}>
                          Cancel
                        </button>
                        <button type="button" onClick={() => void saveEdit(n.id)}>
                          Save
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {task.parentTaskRef && (
            <section className="task-parent-link">
              <p className="muted small">
                Instance of <code>{task.parentTaskRef}</code>
              </p>
            </section>
          )}

          {task.spawnsCraftbook && (
            <section className="task-template">
              <h4>
                Template{' '}
                <span className="muted small">
                  (blueprint for each child: {task.spawnsCraftbook.steps.length} step
                  {task.spawnsCraftbook.steps.length === 1 ? '' : 's'})
                </span>
              </h4>
              <ul className="task-template-steps">
                {task.spawnsCraftbook.steps.map((p, i) => (
                  <li key={`${p.name}-${i}`}>
                    <strong>{p.name}</strong>
                    {p.suggestedGezelId && (
                      <span className="muted small"> — {gezelName(p.suggestedGezelId)}</span>
                    )}
                    {p.description && <div className="muted small">{p.description}</div>}
                  </li>
                ))}
              </ul>
              {task.spawnsCraftbook.plan && (
                <p className="muted small">
                  <strong>Default plan:</strong> {task.spawnsCraftbook.plan}
                </p>
              )}
              <div className="task-template-actions">
                <button type="button" onClick={() => void spawnInstance()} disabled={busy}>
                  + Spawn instance
                </button>
              </div>
            </section>
          )}

          {task.fanout && (
            <section className="task-fanout">
              <h4>Fanout</h4>
              <p className="muted small">
                count: <strong>{task.fanout.count}</strong>
                {task.fanout.materializedAt ? (
                  <> · materialized {task.fanout.materializedAt}</>
                ) : (
                  <> · not yet materialized</>
                )}
                {task.fanout.variations && <> · {task.fanout.variations.length} variation(s)</>}
              </p>
            </section>
          )}

          {task.spawnsCraftbook && (
            <section className="task-children">
              <h4>
                Instances <span className="muted small">({children.length})</span>
              </h4>
              {children.length === 0 ? (
                <p className="muted small">No children spawned yet.</p>
              ) : (
                <ul className="task-children-list">
                  {children.map((c) => (
                    <li key={c.ref}>
                      <span className={`task-status task-status-${c.status}`}>{c.status}</span>
                      <span className="task-ref">{c.ref}</span>
                      <span className="task-title">{c.title}</span>
                      <span className="task-session-time">{c.updatedAt}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {task.cron && (
            <section className="task-cron">
              <h4>Cron</h4>
              <p className="muted small">
                <code>{task.cron.expression}</code>
                {task.cron.nextTickAt && <> — next tick {task.cron.nextTickAt}</>}
                {task.cron.lastTickAt && <> — last tick {task.cron.lastTickAt}</>}
              </p>
              <label className="task-cron-overlap">
                Overlap
                <Select.Root
                  value={task.cron.overlap ?? 'skip'}
                  disabled={busy}
                  onValueChange={(v) => void setCronOverlap(v as CronOverlap)}
                >
                  <Select.Trigger>
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="skip">skip — wait for active child to finish</Select.Item>
                    <Select.Item value="queue">queue — always spawn; runner throttles</Select.Item>
                    <Select.Item value="concurrent">concurrent — always spawn</Select.Item>
                  </Select.Content>
                </Select.Root>
              </label>
            </section>
          )}
        </div>
      )}

      <PromptDialog
        open={addStepOpen}
        title="Add a step"
        message={`New step for "${task.title}". Steps advance in order, and you can jump back to an earlier one from the complete flow.`}
        placeholder="e.g. Review & iterate"
        submitLabel="Add step"
        required
        onCancel={() => setAddStepOpen(false)}
        onSubmit={async (name) => {
          await addStep(name);
          setAddStepOpen(false);
        }}
      />
    </div>
  );
}
