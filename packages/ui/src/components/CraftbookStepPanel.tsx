import type { CraftbookStep, GezelSummary, UpdateTaskStepRequest } from '@bendyline/gezel';
import { normalizeScriptRefs, normalizeStepGate } from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { Select } from '../primitives/index.js';
import { MarkdownField } from './MarkdownField.js';
import type { RecentTabInput } from './recent-tabs.js';

interface CraftbookStepPanelProps {
  craftbookId: string;
  steps: CraftbookStep[];
  /** The step currently selected for viewing/editing. */
  stepId: string | null;
  entryStepId: string;
  gezels: GezelSummary[];
  readOnly: boolean;
  busy: boolean;
  onPatch: (stepId: string, patch: UpdateTaskStepRequest) => void | Promise<void>;
  onRemove: (stepId: string) => void | Promise<void>;
  onSetEntry: (stepId: string) => void | Promise<void>;
}

function openTab(input: RecentTabInput) {
  window.dispatchEvent(new CustomEvent('gezel:open-tab', { detail: input }));
}

/**
 * Per-step editor for the craftbook editor — the design-mode sibling of
 * `TaskStepPanel`. Reuses the same `task-step-panel*` CSS and the
 * draft-in-ref + save-on-blur pattern, but covers the full design surface
 * (name, role, routing, scripts) with no lifecycle (Activate/Complete)
 * controls. Scripts are bundled in the craftbook and edited in Monaco via
 * the `craftbook-script` tab.
 */
export function CraftbookStepPanel({
  craftbookId,
  steps,
  stepId,
  entryStepId,
  gezels,
  readOnly,
  busy,
  onPatch,
  onRemove,
  onSetEntry,
}: CraftbookStepPanelProps) {
  const step = stepId ? (steps.find((s) => s.id === stepId) ?? null) : null;

  const [key, setKey] = useState<string | null>(stepId);
  const nameDraft = useRef<string>(step?.name ?? '');
  const descDraft = useRef<string>(step?.description ?? '');
  const promptDraft = useRef<string>(step?.prompt ?? '');
  const roleDraft = useRef<string>(step?.suggestedRole ?? '');

  useEffect(() => {
    nameDraft.current = step?.name ?? '';
    descDraft.current = step?.description ?? '';
    promptDraft.current = step?.prompt ?? '';
    roleDraft.current = step?.suggestedRole ?? '';
    setKey(step?.id ?? null);
  }, [step?.id, step?.name, step?.description, step?.prompt, step?.suggestedRole]);

  if (!step) {
    return (
      <section className="task-step-panel empty">
        <p className="muted small">
          {steps.length === 0
            ? 'No steps yet — add one with the + button to begin.'
            : 'Select a step above to view and edit it.'}
        </p>
      </section>
    );
  }

  const isEntry = step.id === entryStepId;

  const patch = (p: UpdateTaskStepRequest) => {
    if (readOnly) return;
    void onPatch(step.id, p);
  };
  const saveName = () => {
    const v = nameDraft.current.trim();
    if (!v || v === step.name) return;
    patch({ name: v });
  };
  const saveDesc = () => {
    if (descDraft.current === (step.description ?? '')) return;
    patch({ description: descDraft.current });
  };
  const savePrompt = () => {
    if (promptDraft.current === (step.prompt ?? '')) return;
    patch({ prompt: promptDraft.current });
  };
  const saveRole = () => {
    const v = roleDraft.current.trim();
    if (v === (step.suggestedRole ?? '')) return;
    patch({ suggestedRole: v ? v : null });
  };

  const assigneeValue: string = step.assignee
    ? step.assignee.kind === 'user'
      ? '__user'
      : step.assignee.gezelId
    : step.suggestedGezelId
      ? step.suggestedGezelId
      : '__none';
  const onAssigneeChange = (v: string) => {
    if (v === '__user') patch({ assignee: { kind: 'user' }, suggestedGezelId: null });
    else if (v === '__none') patch({ assignee: null, suggestedGezelId: null });
    else patch({ assignee: null, suggestedGezelId: v });
  };

  const nextValue = step.terminal ? '__terminal' : (step.next ?? '__linear');
  const onNextChange = (v: string) => {
    if (v === '__terminal') patch({ terminal: true, next: null });
    else if (v === '__linear') patch({ terminal: false, next: null });
    else patch({ terminal: false, next: v });
  };

  const scriptRow = (moment: 'enter' | 'exit') => {
    const refs = normalizeScriptRefs(moment === 'enter' ? step.onEnter : step.onExit);
    const field = moment === 'enter' ? 'onEnter' : 'onExit';
    const commit = (next: typeof refs) =>
      patch({ [field]: next.length > 0 ? next : null } as UpdateTaskStepRequest);
    return (
      <div className="step-script-row">
        <span className="step-script-moment muted small">on {moment}</span>
        {refs.length === 0 && readOnly && <span className="muted small">—</span>}
        {refs.map((ref, i) => (
          <span key={`${ref.scope ?? 'craftbook'}:${ref.name}:${i}`} className="step-script-chip">
            <button
              type="button"
              className="link-button"
              onClick={() => {
                // Craftbook-embedded scripts open in the craftbook script
                // editor; scoped refs (standard/user) are referenced only.
                if (ref.scope === undefined || ref.scope === 'craftbook') {
                  openTab({ kind: 'craftbook-script', craftbookId, name: ref.name });
                }
              }}
              title={ref.scope ? `${ref.scope} script` : 'Open this script in the editor'}
            >
              ⚙ {ref.name}
              {ref.scope && ref.scope !== 'craftbook' ? ` (${ref.scope})` : ''}
            </button>
            {!readOnly && (
              <button
                type="button"
                className="link-button muted"
                onClick={() => commit(refs.filter((_, j) => j !== i))}
              >
                detach
              </button>
            )}
          </span>
        ))}
        {!readOnly && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              const name = `${step.id}-${moment}${refs.length > 0 ? `-${refs.length + 1}` : ''}`;
              commit([...refs, { name }]);
              openTab({ kind: 'craftbook-script', craftbookId, name });
            }}
          >
            + attach script
          </button>
        )}
      </div>
    );
  };

  const routingSummary: string[] = [];
  if (step.gate) {
    const gate = normalizeStepGate(step.gate);
    const parts = [
      ...(gate.checks.length > 0 ? [`${gate.checks.length} check(s)`] : []),
      ...(gate.scripts.length > 0 ? [`${gate.scripts.length} script(s)`] : []),
    ];
    routingSummary.push(`gate at ${gate.at}: ${parts.join(' + ') || 'empty'}`);
  }
  if (step.advanceWhen) routingSummary.push(`auto-advance on ${step.advanceWhen.file}`);
  if (step.branches && step.branches.length > 0)
    routingSummary.push(`${step.branches.length} branch(es)`);

  return (
    <section className="task-step-panel">
      <header className="task-step-panel-header">
        <div className="task-step-panel-title">
          <h4>{step.name}</h4>
          {isEntry && <span className="step-status-pill status-active">Entry</span>}
        </div>
        {!readOnly && (
          <div className="task-step-panel-actions">
            <button
              type="button"
              onClick={() => void onSetEntry(step.id)}
              disabled={busy || isEntry}
              title="Make this the craftbook's entry step"
            >
              Set as entry
            </button>
            <button
              type="button"
              onClick={() => void onRemove(step.id)}
              disabled={busy || steps.length <= 1}
              title={steps.length <= 1 ? 'A craftbook needs at least one step' : 'Delete this step'}
            >
              Delete
            </button>
          </div>
        )}
      </header>

      <div className="task-step-panel-grid">
        <label className="task-step-field">
          <span className="task-step-field-label">Name</span>
          <input
            key={`name-${key}`}
            defaultValue={step.name}
            disabled={readOnly}
            onChange={(e) => {
              nameDraft.current = e.target.value;
            }}
            onBlur={saveName}
          />
        </label>

        <label className="task-step-field">
          <span className="task-step-field-label">Suggested role</span>
          <input
            key={`role-${key}`}
            defaultValue={step.suggestedRole ?? ''}
            disabled={readOnly}
            placeholder="developer, reviewer, designer…"
            onChange={(e) => {
              roleDraft.current = e.target.value;
            }}
            onBlur={saveRole}
          />
        </label>

        <label className="task-step-field">
          <span className="task-step-field-label">Assignee (override)</span>
          <Select.Root
            value={assigneeValue}
            disabled={readOnly || busy}
            onValueChange={onAssigneeChange}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="__none">— by role —</Select.Item>
              <Select.Item value="__user">→ user</Select.Item>
              {gezels.map((g) => (
                <Select.Item key={g.id} value={g.id}>
                  → {g.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>

        <label className="task-step-field">
          <span className="task-step-field-label">Next step</span>
          <Select.Root value={nextValue} disabled={readOnly || busy} onValueChange={onNextChange}>
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="__linear">→ next in order</Select.Item>
              <Select.Item value="__terminal">■ terminal (ends here)</Select.Item>
              {steps
                .filter((s) => s.id !== step.id)
                .map((s) => (
                  <Select.Item key={s.id} value={s.id}>
                    → {s.name}
                  </Select.Item>
                ))}
            </Select.Content>
          </Select.Root>
        </label>

        <div className="task-step-field full-width">
          <span className="task-step-field-label">Description</span>
          <MarkdownField
            key={`desc-${key}`}
            value={step.description ?? ''}
            readOnly={readOnly}
            placeholder="What this step produces, who it's for, what 'done' looks like."
            onCommit={(md) => {
              descDraft.current = md;
              saveDesc();
            }}
          />
        </div>

        <div className="task-step-field full-width">
          <span className="task-step-field-label">
            Prompt <span className="muted small">— step-specific guidance for the assignee</span>
          </span>
          <MarkdownField
            key={`prompt-${key}`}
            value={step.prompt ?? ''}
            readOnly={readOnly}
            placeholder="Instructions the assignee can lean on for this step."
            onCommit={(md) => {
              promptDraft.current = md;
              savePrompt();
            }}
          />
        </div>

        <div className="task-step-field full-width">
          <span className="task-step-field-label">Scripts</span>
          <div className="step-scripts">
            {scriptRow('enter')}
            {scriptRow('exit')}
          </div>
        </div>

        {routingSummary.length > 0 && (
          <div className="task-step-field full-width">
            <span className="task-step-field-label">Routing</span>
            <p className="muted small">
              {routingSummary.join(' · ')} — edit gates/branches/auto-advance via the AI assist.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
