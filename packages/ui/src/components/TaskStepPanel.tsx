import type {
  CompleteStepGateInfo,
  GezelSummary,
  ListScriptsResponse,
  Task,
  TaskAssignee,
  TaskCraftbookStep,
  UpdateTaskStepRequest,
} from '@bendyline/gezel';
import { normalizeScriptRefs } from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { MarkdownField } from './MarkdownField.js';
import { StepAutomationRow, StepGateRow } from './StepAutomationRow.js';

interface TaskStepPanelProps {
  task: Task;
  /** The step currently selected for viewing/editing. May be null when the task has no steps. */
  stepId: string | null;
  gezels: GezelSummary[];
  busy: boolean;
  /** Latest completion-gate rejection (rendered when it names the selected step). */
  gateRejection?: (CompleteStepGateInfo & { stepId: string }) | null;
  onActivate: (stepId: string) => void | Promise<void>;
  onComplete: (stepId: string) => void | Promise<void>;
  /** User-only gate bypass ("Complete anyway"). */
  onForceComplete?: (stepId: string) => void | Promise<void>;
  onPatch: (stepId: string, patch: UpdateTaskStepRequest) => void | Promise<void>;
}

function statusLabel(phase: TaskCraftbookStep, activeStepId: string | undefined): string {
  if (phase.completedAt) return 'Completed';
  if (phase.id === activeStepId) return 'Active';
  return 'Pending';
}

export function TaskStepPanel({
  task,
  stepId,
  gezels,
  busy,
  gateRejection,
  onActivate,
  onComplete,
  onForceComplete,
  onPatch,
}: TaskStepPanelProps) {
  const phase = stepId ? (task.craftbook.steps.find((p) => p.id === stepId) ?? null) : null;

  // Drafts live in refs so keystrokes don't re-render the whole panel.
  // We mirror them into local state for re-mount keys when the selected
  // step changes (so the textareas reset to the new step's content).
  const [phaseKey, setPhaseKey] = useState<string | null>(stepId);
  const descDraft = useRef<string>(phase?.description ?? '');
  const promptDraft = useRef<string>(phase?.prompt ?? '');
  // Script libraries feed the automation rows (capability pills, the
  // grouped picker, hook-settings input forms). One fetch each per panel.
  const [projectScripts, setProjectScripts] = useState<ListScriptsResponse['scripts'] | null>(null);
  const [standardScripts, setStandardScripts] = useState<ListScriptsResponse['scripts'] | null>(
    null,
  );

  useEffect(() => {
    descDraft.current = phase?.description ?? '';
    promptDraft.current = phase?.prompt ?? '';
    setPhaseKey(phase?.id ?? null);
  }, [phase?.id, phase?.description, phase?.prompt]);

  useEffect(() => {
    let cancelled = false;
    api
      .listProjectScripts(task.projectId)
      .then((res) => {
        if (!cancelled) setProjectScripts(res.scripts);
      })
      .catch(() => {
        if (!cancelled) setProjectScripts([]);
      });
    api
      .listStandardScripts()
      .then((res) => {
        if (!cancelled) setStandardScripts(res.scripts);
      })
      .catch(() => {
        if (!cancelled) setStandardScripts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [task.projectId]);

  if (!phase) {
    return (
      <section className="task-step-panel empty">
        <p className="muted small">
          {task.craftbook.steps.length === 0
            ? 'No steps yet — add one with the + button to begin.'
            : 'Select a step above to view and edit it.'}
        </p>
      </section>
    );
  }

  const isActive = phase.id === task.activeStepId;
  const isDone = Boolean(phase.completedAt);

  const saveDescription = () => {
    const next = descDraft.current;
    if (next === (phase.description ?? '')) return;
    void onPatch(phase.id, { description: next });
  };
  const savePrompt = () => {
    const next = promptDraft.current;
    if (next === (phase.prompt ?? '')) return;
    void onPatch(phase.id, { prompt: next });
  };
  const onAssigneeChange = (v: string) => {
    if (v === '__user') void onPatch(phase.id, { assignee: { kind: 'user' } });
    else if (v === '__none') void onPatch(phase.id, { assignee: null });
    else void onPatch(phase.id, { assignee: { kind: 'gezel', gezelId: v } });
  };

  const assigneeValue: string = phase.assignee
    ? phase.assignee.kind === 'user'
      ? '__user'
      : phase.assignee.gezelId
    : '__none';

  return (
    <section className="task-step-panel" data-testid="task-step-panel">
      <header className="task-step-panel-header">
        <div className="task-step-panel-title">
          <h4>{phase.name}</h4>
          <span
            className={`step-status-pill status-${isDone ? 'done' : isActive ? 'active' : 'pending'}`}
          >
            {statusLabel(phase, task.activeStepId)}
          </span>
        </div>
        <div className="task-step-panel-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => void onActivate(phase.id)}
            disabled={busy || isActive || isDone}
            title={isActive ? 'This step is already active' : 'Make this the active step'}
          >
            Activate
          </button>
          <button
            type="button"
            onClick={() => void onComplete(phase.id)}
            disabled={busy || isDone}
            title={isDone ? 'Step already complete' : 'Mark this step complete'}
          >
            Complete
          </button>
        </div>
      </header>

      {gateRejection && gateRejection.stepId === phase.id && (
        <div className="step-gate-rejection">
          <strong>
            Not completed — the gate rejected this step (attempt {gateRejection.attempt}/
            {gateRejection.maxAttempts}
            {gateRejection.paused ? ', task paused' : ''}).
          </strong>
          <p>{gateRejection.message}</p>
          {onForceComplete && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void onForceComplete(phase.id)}
            >
              Complete anyway
            </button>
          )}
        </div>
      )}

      <div className="task-step-panel-grid">
        <div className="task-step-field full-width">
          <span className="task-step-field-label">Description</span>
          <MarkdownField
            key={`desc-${phaseKey}`}
            value={phase.description ?? ''}
            placeholder="What this step produces, who it's for, what 'done' looks like."
            onCommit={(md) => {
              descDraft.current = md;
              saveDescription();
            }}
          />
        </div>

        <label className="task-step-field">
          <span className="task-step-field-label">Assignee</span>
          <Select.Root value={assigneeValue} disabled={busy} onValueChange={onAssigneeChange}>
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="__none">— inherit from task —</Select.Item>
              <Select.Item value="__user">→ You</Select.Item>
              {gezels.map((g) => (
                <Select.Item key={g.id} value={g.id}>
                  → {g.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>

        <div className="task-step-field full-width">
          <span className="task-step-field-label">
            Prompt
            <span className="muted small"> — step-specific context / instructions</span>
          </span>
          <MarkdownField
            key={`prompt-${phaseKey}`}
            value={phase.prompt ?? ''}
            placeholder="Step-specific guidance the team can lean on."
            onCommit={(md) => {
              promptDraft.current = md;
              savePrompt();
            }}
          />
        </div>

        <div className="task-step-field full-width">
          <span className="task-step-field-label">Automations</span>
          <div className="step-scripts">
            <StepAutomationRow
              moment="enter"
              refs={normalizeScriptRefs(phase.onEnter)}
              projectId={task.projectId}
              libraries={{ project: projectScripts, standard: standardScripts }}
              busy={busy}
              onChange={(refs) => onPatch(phase.id, { onEnter: refs })}
            />
            <StepGateRow
              gate={phase.gate}
              projectId={task.projectId}
              libraries={{ project: projectScripts, standard: standardScripts }}
              busy={busy}
              stepOptions={task.craftbook.steps.map((s) => ({ id: s.id, name: s.name }))}
              onChange={(gate) => onPatch(phase.id, { gate })}
            />
            <StepAutomationRow
              moment="exit"
              refs={normalizeScriptRefs(phase.onExit)}
              projectId={task.projectId}
              libraries={{ project: projectScripts, standard: standardScripts }}
              busy={busy}
              onChange={(refs) => onPatch(phase.id, { onExit: refs })}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
