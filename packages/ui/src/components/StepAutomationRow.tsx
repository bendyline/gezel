import type {
  GateScriptRef,
  ListScriptsResponse,
  ScriptMeta,
  ScriptOutputPredicate,
  ScriptRef,
  ScriptScope,
  StepGate,
  StepGateUnion,
} from '@bendyline/gezel';
import { isLegacyGateSpec, normalizeStepGate } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { Dialog } from '../primitives/index.js';
import { CapabilityPills } from './CapabilityPills.js';
import { NewScriptDialog } from './NewScriptDialog.js';
import { ScriptInputFields, buildDefaultInputs } from './ScriptRunForm.js';

/**
 * The per-step automation rows on a task step — *when it starts / to
 * finish / when it finishes* — the main door through which
 * non-programmers meet scripts.
 * Everything reads as sentences: when it runs, what it's allowed to do,
 * what happens after. Each event holds an ordered LIST of parameterized
 * script refs; the gate row additionally owns the gate's settings
 * (reject budget, loop-back target).
 */

type ScriptEntry = ListScriptsResponse['scripts'][number];

/** Script choices the pickers offer, grouped by resolution scope. */
export interface ScriptLibraries {
  /** This project's scripts (null while loading). */
  project: ScriptEntry[] | null;
  /** The read-only standard library packed into the app. */
  standard: ScriptEntry[] | null;
  /** The cross-project shared library — `user` scope (null while loading). */
  shared: ScriptEntry[] | null;
}

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.7l-2-3.4a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.5l-.4 2.6a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.6a.5.5 0 0 0-.1.7l2 3.4c.1.2.4.3.6.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.6c0 .3.2.5.5.5h4c.3 0 .5-.2.5-.5l.4-2.6a7.7 7.7 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.7L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
    </svg>
  );
}

function findEntry(
  libraries: ScriptLibraries,
  ref: { name: string; scope?: ScriptScope },
): ScriptEntry | null {
  const list =
    ref.scope === 'standard'
      ? libraries.standard
      : ref.scope === 'user'
        ? libraries.shared
        : libraries.project;
  return list?.find((s) => s.name === ref.name) ?? null;
}

/** What happens after the script finishes, as one sentence. */
function afterSentence(moment: 'enter' | 'exit', ref: ScriptRef): string {
  const advanceVerb =
    moment === 'enter' ? 'this step completes and the task moves on' : 'the next step starts';
  const when = ref.autoAdvanceWhen;
  if (when) {
    switch (when.op) {
      case 'ok':
        return `When it succeeds, ${advanceVerb}.`;
      case 'always':
        return `Afterwards, ${advanceVerb} no matter what.`;
      case 'never':
        return '';
      case 'equals':
        return `When ${when.field} is ${JSON.stringify(when.value)}, ${advanceVerb}.`;
      case 'exists':
        return when.negate
          ? `When ${when.field} has no value, ${advanceVerb}.`
          : `When ${when.field} has a value, ${advanceVerb}.`;
      case 'gt':
        return `When ${when.field} is greater than ${when.value}, ${advanceVerb}.`;
    }
  }
  if (ref.autoAdvanceOnSuccess) return `When it succeeds, ${advanceVerb}.`;
  return '';
}

type AdvanceChoice = 'record' | 'on-success' | 'when';

function adviceChoiceOf(ref: ScriptRef | null): AdvanceChoice {
  if (ref?.autoAdvanceWhen && ref.autoAdvanceWhen.op !== 'never') {
    return ref.autoAdvanceWhen.op === 'ok' ? 'on-success' : 'when';
  }
  if (ref?.autoAdvanceOnSuccess) return 'on-success';
  return 'record';
}

/** Parse the free-text comparison value: number / boolean / string. */
function parseEqualsValue(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return raw;
}

/**
 * Friendly label for a script name shown to non-developers: drop the
 * standard-library `check` prefix and split camelCase into words, e.g.
 * `checkFileMinBytes` → "File Min Bytes", `checkGrepMatches` → "Grep
 * Matches". The raw name is still the identity (kept in a tooltip).
 */
function humanizeScriptName(name: string): string {
  const base = name.replace(/^check(?=[A-Z])/, '') || name;
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function scopeTag(scope: ScriptScope | undefined): string | null {
  if (scope === 'standard') return 'standard';
  if (scope === 'user') return 'shared library';
  if (scope === 'craftbook') return 'craftbook';
  return null;
}

/* ───────────────────────── enter / exit rows ─────────────────────────── */

export function StepAutomationRow({
  moment,
  refs,
  projectId,
  libraries,
  busy,
  onChange,
}: {
  moment: 'enter' | 'exit';
  refs: ScriptRef[];
  projectId: string;
  libraries: ScriptLibraries;
  busy: boolean;
  onChange: (refs: ScriptRef[] | null) => void | Promise<void>;
}) {
  // Which ref's settings dialog is open: index into refs, or 'new'.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  // Human moments, not lifecycle-hook names: the rows read "when it
  // starts — run …" / "when it finishes — run …".
  const momentLabel = moment === 'enter' ? 'when it starts' : 'when it finishes';

  const commit = (next: ScriptRef[]) => {
    void onChange(next.length > 0 ? next : null);
  };

  const sentence =
    refs.length > 0
      ? moment === 'enter'
        ? 'Runs automatically when this step starts.'
        : 'Runs automatically after this step is approved to complete (cleanup).'
      : null;
  const after = refs.map((r) => afterSentence(moment, r)).filter(Boolean)[0];

  return (
    <div className="step-script-row">
      <span className="step-script-moment muted small">{momentLabel}</span>
      {refs.length === 0 && <span className="muted small">—</span>}
      {refs.map((ref, i) => (
        <span key={`${ref.scope ?? 'project'}:${ref.name}:${i}`} className="step-script-chip">
          <span className="step-script-name">
            <GearIcon /> {ref.name}
          </span>
          {scopeTag(ref.scope) && <em className="muted small"> {scopeTag(ref.scope)}</em>}
          <button
            type="button"
            className="step-script-configure muted small"
            disabled={busy}
            onClick={() => setEditing(i)}
          >
            Settings
          </button>
          <button
            type="button"
            className="step-script-configure muted small"
            disabled={busy}
            onClick={() => commit(refs.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </span>
      ))}
      <button
        type="button"
        className="step-script-add small"
        disabled={busy}
        onClick={() => setEditing('new')}
      >
        + Add automation
      </button>
      {sentence && (
        <p className="step-script-sentence muted small">
          {sentence}
          {after ? ` ${after}` : ''}
        </p>
      )}

      <HookDialog
        open={editing !== null}
        mode={moment}
        projectId={projectId}
        libraries={libraries}
        existingRef={typeof editing === 'number' ? (refs[editing] ?? null) : null}
        onClose={() => setEditing(null)}
        onSave={(ref) => {
          const idx = editing;
          setEditing(null);
          if (ref === null) {
            if (typeof idx === 'number') commit(refs.filter((_, j) => j !== idx));
            return;
          }
          if (typeof idx === 'number') {
            commit(refs.map((r, j) => (j === idx ? ref : r)));
          } else {
            commit([...refs, ref]);
          }
        }}
      />
    </div>
  );
}

/* ─────────────────────────────── gate row ────────────────────────────── */

export function StepGateRow({
  gate,
  projectId,
  libraries,
  busy,
  stepOptions,
  onChange,
}: {
  gate: StepGateUnion | undefined;
  projectId: string;
  libraries: ScriptLibraries;
  busy: boolean;
  /** Step ids selectable as the reject loop-back target. */
  stepOptions: Array<{ id: string; name: string }>;
  onChange: (gate: StepGate | null) => void | Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const legacy = gate !== undefined && isLegacyGateSpec(gate);
  const normalized = gate ? normalizeStepGate(gate) : null;
  const scripts: GateScriptRef[] = !gate || legacy ? [] : (gate.scripts ?? []);

  // Conditions are edited inline; keystrokes mutate a local draft and only
  // flush to disk on blur (one patch per edit session, not per character).
  // Add/remove commit immediately. We re-seed from props whenever the
  // persisted scripts change — including right after our own flush, which
  // is a harmless no-op since draft already equals the new value.
  const scriptsSig = JSON.stringify(scripts);
  const [draft, setDraft] = useState<GateScriptRef[]>(scripts);
  // scriptsSig is the serialized identity of `scripts`; keying the re-seed on
  // it (not the array) avoids re-seeding every render and clobbering edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on scriptsSig by design
  useEffect(() => {
    setDraft(scripts);
  }, [scriptsSig]);

  const commitScripts = (nextScripts: GateScriptRef[]) => {
    const base: StepGate = gate && !legacy ? { ...(gate as StepGate) } : { at: 'completion' };
    const next: StepGate = { ...base, scripts: nextScripts };
    if ((next.scripts?.length ?? 0) === 0 && (next.checks?.length ?? 0) === 0) {
      void onChange(null);
    } else {
      void onChange(next);
    }
  };

  // Push unsaved inline-input edits to disk (called on blur of a condition).
  const flush = () => {
    if (JSON.stringify(draft) !== scriptsSig) commitScripts(draft);
  };

  const updateInputs = (i: number, inputs: Record<string, unknown>) => {
    const cleaned = Object.fromEntries(
      Object.entries(inputs).filter(([, v]) => v !== undefined && v !== ''),
    );
    setDraft((d) =>
      d.map((r, j) =>
        j === i
          ? ({
              ...r,
              ...(Object.keys(cleaned).length ? { inputs: cleaned } : { inputs: undefined }),
            } as GateScriptRef)
          : r,
      ),
    );
  };

  const addCondition = (sel: { name: string; scope?: ScriptScope }) => {
    const entry = findEntry(libraries, sel);
    const defaults = entry?.meta ? buildDefaultInputs(entry.meta) : {};
    const cleaned = Object.fromEntries(
      Object.entries(defaults).filter(([, v]) => v !== undefined && v !== ''),
    );
    const ref: GateScriptRef = {
      name: sel.name,
      ...(sel.scope ? { scope: sel.scope } : {}),
      ...(Object.keys(cleaned).length ? { inputs: cleaned } : {}),
    };
    setAdding(false);
    commitScripts([...draft, ref]);
  };

  if (legacy && normalized) {
    // Legacy evaluator-step gates keep working at runtime; their shape
    // (onFail/onPass static checks) predates script gates and is edited
    // via the craftbook editor, not this row.
    return (
      <div className="step-script-row">
        <span className="step-script-moment muted small">to finish</span>
        <span className="muted small">
          legacy evaluator gate — {normalized.checks.length} check(s), max {normalized.maxAttempts}{' '}
          attempts
        </span>
      </div>
    );
  }

  const builtinChecks = normalized?.checks.length ?? 0;
  const hasAny = draft.length > 0 || builtinChecks > 0;

  return (
    <div className="step-script-row gate-row">
      <span className="step-script-moment muted small">to finish</span>

      <div className="gate-conditions">
        {!hasAny && (
          <p className="muted small gate-conditions-empty">
            No conditions — this step completes as soon as it's marked done.
          </p>
        )}
        {builtinChecks > 0 && (
          <p className="muted small gate-conditions-builtin">
            {builtinChecks} built-in check{builtinChecks === 1 ? '' : 's'}
          </p>
        )}

        {draft.map((ref, i) => {
          const entry = findEntry(libraries, ref);
          const meta: ScriptMeta | undefined = entry?.meta;
          const hasInputs = meta?.inputs && Object.keys(meta.inputs).length > 0;
          return (
            <div
              key={`${ref.scope ?? 'project'}:${ref.name}:${i}`}
              className="gate-condition"
              onBlur={flush}
            >
              <div className="gate-condition-head">
                <span className="gate-condition-name" title={ref.name}>
                  <GearIcon /> {humanizeScriptName(ref.name)}
                </span>
                {scopeTag(ref.scope) && <em className="muted small">{scopeTag(ref.scope)}</em>}
                <span className="gate-condition-spacer" />
                <button
                  type="button"
                  className="step-script-configure muted small"
                  disabled={busy}
                  onClick={() => commitScripts(draft.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
              {meta?.description && (
                <p className="gate-condition-desc muted small">{meta.description}</p>
              )}
              {hasInputs && meta?.inputs && (
                <div className="gate-condition-inputs">
                  <ScriptInputFields
                    inputs={meta.inputs}
                    values={ref.inputs ?? {}}
                    onChange={(v) => updateInputs(i, v)}
                  />
                </div>
              )}
              {!entry && (
                <p className="muted small">
                  Not in this project's library — it'll still run if it exists at completion time.
                </p>
              )}
            </div>
          );
        })}

        <button
          type="button"
          className="gate-condition-add"
          disabled={busy}
          onClick={() => setAdding(true)}
        >
          + Add condition
        </button>
      </div>

      {gate && !legacy && (
        <button
          type="button"
          className="step-script-configure muted small gate-settings-link"
          disabled={busy}
          onClick={() => setSettingsOpen(true)}
        >
          Gate settings
        </button>
      )}

      {hasAny && (
        <p className="step-script-sentence muted small">
          Every condition must approve before this step can finish. A rejection holds the step and
          tells the worker exactly what to fix
          {normalized?.onReject ? ', looping back for a fresh pass' : ''}; after{' '}
          {normalized?.maxAttempts ?? 4} rejections the task pauses for you.
        </p>
      )}

      <Dialog.Root
        open={adding && !creating}
        onOpenChange={(next) => {
          if (!next) setAdding(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="hook-dialog">
            <Dialog.Title asChild>
              <h3>Add a condition</h3>
            </Dialog.Title>
            <Dialog.Description className="muted small">
              Pick a check the step must pass before it can finish. You can set its details after
              adding it.
            </Dialog.Description>
            <ScriptPicker
              mode="gate"
              libraries={libraries}
              onPick={addCondition}
              onNewScript={() => setCreating(true)}
            />
            <Dialog.Actions>
              <button type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </Dialog.Actions>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <NewScriptDialog
        open={creating}
        projectId={projectId}
        onClose={() => setCreating(false)}
        onCreated={(name) => {
          setCreating(false);
          setAdding(false);
          commitScripts([...draft, { name }]);
          window.dispatchEvent(
            new CustomEvent('gezel:open-tab', {
              detail: { kind: 'script', projectId, name, activate: true },
            }),
          );
        }}
      />

      {gate && !legacy && settingsOpen && (
        <GateSettingsDialog
          gate={gate as StepGate}
          stepOptions={stepOptions}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            setSettingsOpen(false);
            void onChange(next);
          }}
        />
      )}
    </div>
  );
}

function GateSettingsDialog({
  gate,
  stepOptions,
  onClose,
  onSave,
}: {
  gate: StepGate;
  stepOptions: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (gate: StepGate) => void;
}) {
  const [maxAttempts, setMaxAttempts] = useState(gate.maxAttempts ?? 4);
  const [onReject, setOnReject] = useState(gate.onReject ?? '');

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content>
          <Dialog.Title asChild>
            <h3>Gate settings</h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            What happens when the gate rejects this step's work.
          </Dialog.Description>
          <label className="new-script-field">
            <span>If rejected</span>
            <select value={onReject} onChange={(e) => setOnReject(e.target.value)}>
              <option value="">stay on this step (worker gets the message)</option>
              {stepOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  go back to "{s.name}" with a fresh session
                </option>
              ))}
            </select>
          </label>
          <label className="new-script-field">
            <span>Pause the task for me after this many rejections</span>
            <input
              type="number"
              min={1}
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(Math.max(1, Number(e.target.value) || 4))}
            />
          </label>
          <Dialog.Actions>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const next: StepGate = { ...gate, maxAttempts };
                if (onReject) next.onReject = onReject;
                else delete next.onReject;
                onSave(next);
              }}
            >
              Save
            </button>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ─────────────────────────── script picker ───────────────────────────── */

/**
 * The grouped script chooser shared by the enter/exit hook dialog and the
 * gate's "add condition" flow. Each entry is a flat card — name, one-line
 * description, capability pills — NOT a primary button (the unclassed
 * buttons used to inherit the global accent fill and render as solid
 * terracotta slabs). In gate mode it shows only `kind: 'gate'` scripts
 * until "show all" is toggled, and lists the standard library first (the
 * no-code path).
 */
function ScriptPicker({
  mode,
  libraries,
  onPick,
  onNewScript,
}: {
  mode: 'enter' | 'exit' | 'gate';
  libraries: ScriptLibraries;
  onPick: (sel: { name: string; scope?: ScriptScope }) => void;
  onNewScript: () => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const gateFilter = (s: ScriptEntry) => !(mode === 'gate' && !showAll) || s.meta.kind === 'gate';
  const groups: Array<{ label: string; scope?: ScriptScope; list: ScriptEntry[] | null }> = [
    { label: 'Standard library', scope: 'standard', list: libraries.standard },
    { label: 'Shared library', scope: 'user', list: libraries.shared },
    { label: 'This project', list: libraries.project },
  ];
  // Standard first for gates (the no-code path); project first otherwise.
  if (mode !== 'gate') groups.reverse();

  return (
    <div className="hook-dialog-picker">
      {groups.map((group) => {
        const list = group.list?.filter(gateFilter) ?? null;
        return (
          <section key={group.label}>
            <h4 className="muted small">{group.label}</h4>
            {list === null ? (
              <p className="muted small">Loading…</p>
            ) : list.length === 0 ? (
              <p className="muted small">Nothing here yet.</p>
            ) : (
              <ul className="script-picker-list">
                {list.map((s) => (
                  <li key={`${group.label}:${s.name}`}>
                    <button
                      type="button"
                      className="script-picker-item"
                      title={s.name}
                      onClick={() =>
                        onPick({ name: s.name, ...(group.scope ? { scope: group.scope } : {}) })
                      }
                    >
                      <span className="script-picker-item-name">{humanizeScriptName(s.name)}</span>
                      <span className="muted small script-picker-item-desc">
                        {s.meta.description}
                      </span>
                      <CapabilityPills requires={s.meta.requires} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <div className="script-picker-actions">
        {mode === 'gate' && !showAll && (
          <button
            type="button"
            className="link-button muted small"
            onClick={() => setShowAll(true)}
          >
            Show non-gate scripts too
          </button>
        )}
        <button type="button" className="link-button" onClick={onNewScript}>
          New script…
        </button>
      </div>
    </div>
  );
}

/* ───────────────────── pick-and-configure dialog ─────────────────────── */

/**
 * Two panes in one Dialog: choose a script (grouped by library), then
 * the settings pane — inputs + (for enter/exit) what happens when it
 * finishes — written as sentences. Gate mode filters to `kind: 'gate'`
 * scripts by default and has no auto-advance radio (a gate's routing
 * comes from its structured result).
 */
function HookDialog({
  open,
  mode,
  projectId,
  libraries,
  existingRef,
  onClose,
  onSave,
}: {
  open: boolean;
  mode: 'enter' | 'exit' | 'gate';
  projectId: string;
  libraries: ScriptLibraries;
  existingRef: ScriptRef | null;
  onClose: () => void;
  onSave: (ref: ScriptRef | null) => void;
}) {
  const [chosen, setChosen] = useState<{ name: string; scope?: ScriptScope } | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [advance, setAdvance] = useState<AdvanceChoice>('record');
  const [whenField, setWhenField] = useState('');
  const [whenOp, setWhenOp] = useState<'equals' | 'gt' | 'exists'>('equals');
  const [whenValue, setWhenValue] = useState('');
  const [creating, setCreating] = useState(false);

  const entry = chosen ? findEntry(libraries, chosen) : null;
  const meta: ScriptMeta | undefined = entry?.meta;

  // (Re)seed the form whenever the dialog opens or the chosen script changes.
  useEffect(() => {
    if (!open) return;
    setChosen(
      existingRef
        ? { name: existingRef.name, ...(existingRef.scope ? { scope: existingRef.scope } : {}) }
        : null,
    );
    setAdvance(adviceChoiceOf(existingRef));
    const when = existingRef?.autoAdvanceWhen;
    if (when && when.op !== 'ok' && when.op !== 'always' && when.op !== 'never') {
      setWhenField(when.field);
      setWhenOp(when.op);
      setWhenValue('value' in when ? String(when.value) : '');
    } else {
      setWhenField('');
      setWhenOp('equals');
      setWhenValue('');
    }
  }, [open, existingRef]);

  useEffect(() => {
    if (!open || !meta) return;
    setInputValues({ ...buildDefaultInputs(meta), ...(existingRef?.inputs ?? {}) });
    if (!whenField) {
      const firstOutput = Object.keys(meta.outputs ?? {})[0];
      if (firstOutput) setWhenField(firstOutput);
    }
  }, [open, meta, existingRef, whenField]);

  const buildRef = (): ScriptRef | null => {
    if (!chosen) return null;
    const ref: ScriptRef = { name: chosen.name };
    if (chosen.scope) ref.scope = chosen.scope;
    const cleanInputs = Object.fromEntries(
      Object.entries(inputValues).filter(([, v]) => v !== undefined && v !== ''),
    );
    if (Object.keys(cleanInputs).length > 0) ref.inputs = cleanInputs;
    if (mode !== 'gate') {
      if (advance === 'on-success') ref.autoAdvanceOnSuccess = true;
      if (advance === 'when' && whenField) {
        let predicate: ScriptOutputPredicate;
        if (whenOp === 'exists') predicate = { op: 'exists', field: whenField };
        else if (whenOp === 'gt')
          predicate = { op: 'gt', field: whenField, value: Number(whenValue) || 0 };
        else predicate = { op: 'equals', field: whenField, value: parseEqualsValue(whenValue) };
        ref.autoAdvanceWhen = predicate;
      }
    }
    return ref;
  };

  const title =
    mode === 'gate'
      ? chosen
        ? `Gate check: "${chosen.name}"`
        : 'Decide whether this step is done'
      : chosen
        ? `Run "${chosen.name}" when this step ${mode === 'enter' ? 'starts' : 'completes'}`
        : `Run a script when this step ${mode === 'enter' ? 'starts' : 'completes'}`;

  return (
    <>
      <Dialog.Root
        open={open && !creating}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="hook-dialog">
            <Dialog.Title asChild>
              <h3>{title}</h3>
            </Dialog.Title>

            {!chosen && (
              <ScriptPicker
                mode={mode}
                libraries={libraries}
                onPick={setChosen}
                onNewScript={() => setCreating(true)}
              />
            )}

            {chosen && meta && (
              <div className="hook-dialog-settings">
                <p className="muted small">
                  {mode === 'gate'
                    ? 'Runs automatically when the step tries to complete. If it rejects, the worker stays on the step and gets its message; if every check approves, the task moves on. It can:'
                    : `This will run automatically — no confirmation — every time the step ${
                        mode === 'enter' ? 'starts' : 'completes'
                      }. It can:`}
                </p>
                <CapabilityPills requires={meta.requires} />
                {(!meta.requires || meta.requires.length === 0) && (
                  <p className="muted small">Nothing outside its own sandbox.</p>
                )}

                {meta.inputs && Object.keys(meta.inputs).length > 0 && (
                  <fieldset className="script-detail__inputs">
                    <legend>Inputs</legend>
                    <ScriptInputFields
                      inputs={meta.inputs}
                      values={inputValues}
                      onChange={setInputValues}
                    />
                  </fieldset>
                )}

                {mode !== 'gate' && (
                  <fieldset className="hook-dialog-advance">
                    <legend>When it finishes</legend>
                    <label>
                      <input
                        type="radio"
                        name={`advance-${mode}`}
                        checked={advance === 'record'}
                        onChange={() => setAdvance('record')}
                      />
                      just record the result
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`advance-${mode}`}
                        checked={advance === 'on-success'}
                        onChange={() => setAdvance('on-success')}
                      />
                      {mode === 'enter'
                        ? 'if it succeeds, complete this step and move on'
                        : 'if it succeeds, start the next step'}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`advance-${mode}`}
                        checked={advance === 'when'}
                        onChange={() => setAdvance('when')}
                        disabled={Object.keys(meta.outputs ?? {}).length === 0}
                      />
                      move on when…
                    </label>
                    {advance === 'when' && (
                      <div className="hook-dialog-when">
                        <select value={whenField} onChange={(e) => setWhenField(e.target.value)}>
                          {Object.keys(meta.outputs ?? {}).map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </select>
                        <select
                          value={whenOp}
                          onChange={(e) => setWhenOp(e.target.value as 'equals' | 'gt' | 'exists')}
                        >
                          <option value="equals">is</option>
                          <option value="gt">is greater than</option>
                          <option value="exists">has a value</option>
                        </select>
                        {whenOp !== 'exists' && (
                          <input
                            type="text"
                            value={whenValue}
                            placeholder="value"
                            onChange={(e) => setWhenValue(e.target.value)}
                          />
                        )}
                      </div>
                    )}
                  </fieldset>
                )}

                {!existingRef && (
                  <button type="button" className="muted small" onClick={() => setChosen(null)}>
                    ‹ Pick a different script
                  </button>
                )}
              </div>
            )}

            <Dialog.Actions>
              {existingRef && (
                <button
                  type="button"
                  className="danger hook-dialog-remove"
                  onClick={() => onSave(null)}
                >
                  Remove
                </button>
              )}
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!chosen}
                onClick={() => onSave(buildRef())}
              >
                {existingRef ? 'Save' : 'Attach'}
              </button>
            </Dialog.Actions>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <NewScriptDialog
        open={creating}
        projectId={projectId}
        onClose={() => setCreating(false)}
        onCreated={(name) => {
          setCreating(false);
          // Attach the fresh script with a bare ref and take the user
          // straight to the editor — writing the script is the natural
          // next step; they can revisit Settings for inputs afterwards.
          onSave({ name });
          window.dispatchEvent(
            new CustomEvent('gezel:open-tab', {
              detail: { kind: 'script', projectId, name, activate: true },
            }),
          );
        }}
      />
    </>
  );
}
