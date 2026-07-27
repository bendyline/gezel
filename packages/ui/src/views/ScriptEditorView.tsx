import type {
  GetScriptSourceResponse,
  RunScriptResponse,
  ScriptDiagnostic,
  ScriptMeta,
  ScriptProvenance,
  ScriptRun,
  Task,
} from '@bendyline/gezel';
import { normalizeScriptRefs, normalizeStepGate } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { CapabilityPills, capabilityLabel } from '../components/CapabilityPills.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { RunResult, ScriptInputFields, buildDefaultInputs } from '../components/ScriptRunForm.js';
import type { EditorProblem } from '../components/script-editor/ScriptCodeEditor.js';
import {
  ScriptEditorTabs,
  type ScriptEditorTabsHandle,
} from '../components/script-editor/ScriptEditorTabs.js';
import { takePendingDraft } from '../components/script-editor/pending-drafts.js';
import { Tabs } from '../primitives/index.js';

/**
 * Full-screen script editor tab: Monaco with typed `gezel.*` IntelliSense
 * on the left, an About / Test-run rail on the right, problems strip
 * along the bottom. Explicit save (Cmd+S / button) — scripts run
 * automatically when task steps activate, so we never autosave a
 * half-typed buffer; unsaved work survives tab switches via a
 * module-scope draft map plus a localStorage mirror as crash insurance.
 */

/** Unsaved buffers, keyed `projectId/name` — survives tab switches. */
const scriptDrafts = new Map<string, string>();

function draftStorageKey(key: string): string {
  return `gezel:script-draft:${key}`;
}

function readDraft(key: string): string | null {
  const inMemory = scriptDrafts.get(key);
  if (inMemory !== undefined) return inMemory;
  try {
    return window.localStorage.getItem(draftStorageKey(key));
  } catch {
    return null;
  }
}

function writeDraft(key: string, source: string): void {
  scriptDrafts.set(key, source);
  try {
    window.localStorage.setItem(draftStorageKey(key), source);
  } catch {
    /* quota / private mode — in-memory draft still applies */
  }
}

function clearDraft(key: string): void {
  scriptDrafts.delete(key);
  try {
    window.localStorage.removeItem(draftStorageKey(key));
  } catch {
    /* ignore */
  }
}

/** Test-only: the module-scope map outlives any single test's DOM. */
export function __clearAllScriptDrafts(): void {
  scriptDrafts.clear();
}

/**
 * Client-side mirror of the provenance markers (see service
 * scripts/install.ts) so detaching — deleting the first line — takes
 * effect in the UI immediately, before any round-trip.
 */
const PROVENANCE_MARKERS = [
  { kind: 'craftbook' as const, marker: '// @gezel-craftbook:' },
  { kind: 'import' as const, marker: '// @gezel-import:' },
];

function parseProvenance(source: string): ScriptProvenance | null {
  for (const { kind, marker } of PROVENANCE_MARKERS) {
    if (!source.startsWith(marker)) continue;
    const nl = source.indexOf('\n');
    const line = nl === -1 ? source : source.slice(0, nl);
    return { kind, ref: line.slice(marker.length).trim() };
  }
  return null;
}

/** Strip the first-line provenance marker (for "Make my own copy"). */
function sourceWithoutMarker(source: string): string {
  if (!PROVENANCE_MARKERS.some(({ marker }) => source.startsWith(marker))) return source;
  const nl = source.indexOf('\n');
  return nl === -1 ? '' : source.slice(nl + 1);
}

/**
 * The dispatcher's capability errors have a stable shape:
 *   script attempted to call "x" (capability: network) but did not
 *   declare it in meta.requires
 * Recognizing it lets the run panel offer a one-click fix instead of a
 * stack trace.
 */
function detectCapabilityViolation(message: string | undefined): string | null {
  if (!message?.includes('did not declare it in meta.requires')) return null;
  return /capability:\s*([\w.:-]+)/.exec(message)?.[1] ?? null;
}

/**
 * Insert a capability into the meta `requires: [...]` array, textually.
 * The meta block only admits literal arrays (enforced by the extractor),
 * so a regex edit is safe in practice; returns null when the array can't
 * be located (caller falls back to pointing the user at the meta block).
 */
function addCapabilityToSource(source: string, cap: string): string | null {
  const m = /requires:\s*\[([^\]]*)\]/.exec(source);
  if (!m) return null;
  const inner = (m[1] ?? '').trim();
  const rewritten = inner.length > 0 ? `requires: [${m[1]}, '${cap}']` : `requires: ['${cap}']`;
  return source.slice(0, m.index) + rewritten + source.slice(m.index + m[0].length);
}

interface StepUsage {
  taskRef: string;
  taskTitle: string;
  stepName: string;
  moment: 'enter' | 'exit' | 'gate';
}

function findStepUsages(tasks: Task[], scriptName: string): StepUsage[] {
  const usages: StepUsage[] = [];
  for (const task of tasks) {
    for (const step of task.craftbook.steps) {
      const base = { taskRef: task.ref, taskTitle: task.title, stepName: step.name };
      if (normalizeScriptRefs(step.onEnter).some((r) => r.name === scriptName)) {
        usages.push({ ...base, moment: 'enter' });
      }
      if (step.gate && normalizeStepGate(step.gate).scripts.some((r) => r.name === scriptName)) {
        usages.push({ ...base, moment: 'gate' });
      }
      if (normalizeScriptRefs(step.onExit).some((r) => r.name === scriptName)) {
        usages.push({ ...base, moment: 'exit' });
      }
    }
  }
  return usages;
}

export interface ScriptEditorViewProps {
  projectId: string;
  scriptName: string;
  /** Library scope to load from; absent = the project's own scripts. */
  scope?: 'standard' | 'user';
}

export function ScriptEditorView({ projectId, scriptName, scope }: ScriptEditorViewProps) {
  const draftKey = `${scope ? `${scope}:` : ''}${projectId}/${scriptName}`;
  const editorRef = useRef<ScriptEditorTabsHandle | null>(null);
  // The packed-in standard library is read-only by construction; opening
  // a standard script is a reference view with a duplicate-to-edit path.
  const isStandard = scope === 'standard';

  const [data, setData] = useState<GetScriptSourceResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The source as last saved — dirty is "buffer differs from this".
  const lastSavedRef = useRef<string>('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ScriptMeta | undefined>(undefined);
  const [metaOk, setMetaOk] = useState(true);
  const [serverDiagnostics, setServerDiagnostics] = useState<ScriptDiagnostic[]>([]);
  const [problems, setProblems] = useState<EditorProblem[]>([]);
  const [conflict, setConflict] = useState<{ currentHash: string; currentSource: string } | null>(
    null,
  );
  const [provenance, setProvenance] = useState<ScriptProvenance | null>(null);
  const [editAnyway, setEditAnyway] = useState(false);
  const [confirmEditAnyway, setConfirmEditAnyway] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [usages, setUsages] = useState<StepUsage[]>([]);
  const [rail, setRail] = useState<'about' | 'run' | null>('about');
  /** AI drafting handed off from the New-script dialog. */
  const [aiDrafting, setAiDrafting] = useState<'busy' | 'failed' | null>(null);

  // Test-run state.
  const [runValues, setRunValues] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunScriptResponse | null>(null);
  const [runDetail, setRunDetail] = useState<ScriptRun | null>(null);
  const [fixingCapability, setFixingCapability] = useState(false);

  const localDraftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraft = useRef<string | null>(null);

  // Clearing a draft has to cancel the debounced mirror write too: saving
  // (or reloading from disk) within the 500ms window would otherwise let
  // the timer resurrect the draft we just dropped, and the tab reopens
  // claiming to have restored unsaved changes that were already saved.
  const dropDraft = useCallback(() => {
    if (localDraftTimer.current) clearTimeout(localDraftTimer.current);
    localDraftTimer.current = null;
    pendingDraft.current = null;
    clearDraft(draftKey);
  }, [draftKey]);

  // Unmount is a tab switch, not a discard — flush the pending mirror
  // write rather than dropping it.
  useEffect(() => {
    return () => {
      if (!localDraftTimer.current) return;
      clearTimeout(localDraftTimer.current);
      localDraftTimer.current = null;
      const source = pendingDraft.current;
      pendingDraft.current = null;
      if (source !== null) writeDraft(draftKey, source);
    };
  }, [draftKey]);

  // ── Load ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load =
      scope === 'standard'
        ? api.getStandardScriptSource(scriptName)
        : scope === 'user'
          ? api.getUserScriptSource(scriptName)
          : api.getProjectScriptSource(projectId, scriptName);
    load
      .then((res) => {
        if (cancelled) return;
        const draft = readDraft(draftKey);
        lastSavedRef.current = res.source;
        setData(draft !== null && draft !== res.source ? { ...res, source: draft } : res);
        setDirty(draft !== null && draft !== res.source);
        setRestoredDraft(draft !== null && draft !== res.source);
        setMeta(res.meta);
        setMetaOk(!res.metaError);
        setProvenance(res.provenance ?? null);
        if (res.metaError) {
          setServerDiagnostics([{ severity: 'error', source: 'meta', message: res.metaError }]);
        }
        if (res.meta) setRunValues(buildDefaultInputs(res.meta));

        // New-script-dialog handoff: draft the body with AI, then drop
        // it into the buffer unsaved so the user reviews before it can
        // ever run. Failure leaves the scaffold + a note, never blocks.
        const draftDescription = takePendingDraft(draftKey);
        if (draftDescription) {
          setAiDrafting('busy');
          api
            .draftProjectScript(projectId, { name: scriptName, description: draftDescription })
            .then(({ source }) => {
              if (cancelled) return;
              setAiDrafting(null);
              if (editorRef.current) {
                editorRef.current.setValue(source);
              } else {
                setData((d) => (d ? { ...d, source } : d));
                setDirty(true);
                scriptDrafts.set(draftKey, source);
              }
            })
            .catch(() => {
              if (!cancelled) setAiDrafting('failed');
            });
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    api
      .listProjectTasks(projectId)
      .then((res) => {
        if (!cancelled) setUsages(findStepUsages(res.tasks, scriptName));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, scriptName, scope, draftKey]);

  // ── Edits ───────────────────────────────────────────────────────────
  const handleChangeContent = useCallback(
    (source: string) => {
      const isDirty = source !== lastSavedRef.current;
      setDirty(isDirty);
      if (!isDirty) {
        dropDraft();
        return;
      }
      scriptDrafts.set(draftKey, source);
      pendingDraft.current = source;
      if (localDraftTimer.current) clearTimeout(localDraftTimer.current);
      localDraftTimer.current = setTimeout(() => {
        localDraftTimer.current = null;
        pendingDraft.current = null;
        writeDraft(draftKey, source);
      }, 500);
    },
    [draftKey, dropDraft],
  );

  // ── Save ────────────────────────────────────────────────────────────
  const save = useCallback(
    async (opts: { overrideHash?: string } = {}): Promise<boolean> => {
      const source = editorRef.current?.getValue();
      if (source === null || source === undefined || !data) return false;
      setSaving(true);
      setSaveError(null);
      try {
        if (scope === 'standard') return false;
        const body = { name: scriptName, source, baseHash: opts.overrideHash ?? data.hash };
        const res =
          scope === 'user'
            ? await api.saveUserScriptSource(body)
            : await api.saveProjectScriptSource(projectId, body);
        if (res.status === 'conflict') {
          setConflict({ currentHash: res.currentHash, currentSource: res.currentSource });
          return false;
        }
        lastSavedRef.current = source;
        setData({ ...data, source, hash: res.hash });
        setDirty(false);
        setRestoredDraft(false);
        dropDraft();
        setConflict(null);
        setMetaOk(res.metaOk);
        if (res.meta) {
          setMeta(res.meta);
          setRunValues((prev) => ({ ...buildDefaultInputs(res.meta as ScriptMeta), ...prev }));
        }
        setServerDiagnostics(res.diagnostics);
        editorRef.current?.setServerDiagnostics(res.diagnostics);
        setProvenance(parseProvenance(source));
        return res.metaOk;
      } catch (err) {
        setSaveError((err as Error).message);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [data, dropDraft, projectId, scriptName, scope],
  );

  // ── Conflict: file changed on disk ──────────────────────────────────
  const reloadFromDisk = useCallback(() => {
    if (!conflict || !data) return;
    lastSavedRef.current = conflict.currentSource;
    setData({ ...data, source: conflict.currentSource, hash: conflict.currentHash });
    editorRef.current?.setValue(conflict.currentSource);
    setDirty(false);
    setRestoredDraft(false);
    dropDraft();
    setProvenance(parseProvenance(conflict.currentSource));
    setConflict(null);
  }, [conflict, data, dropDraft]);

  const overwriteDisk = useCallback(() => {
    if (!conflict) return;
    void save({ overrideHash: conflict.currentHash });
  }, [conflict, save]);

  const discardDraft = useCallback(() => {
    dropDraft();
    editorRef.current?.setValue(lastSavedRef.current);
    setData((d) => (d ? { ...d, source: lastSavedRef.current } : d));
    setDirty(false);
    setRestoredDraft(false);
  }, [dropDraft]);

  // Window-focus revalidation: someone may have edited the file in
  // another editor while the app was backgrounded. Clean buffer →
  // silently adopt; dirty buffer → surface the conflict banner up front.
  useEffect(() => {
    const onFocus = () => {
      if (!data || saving || conflict) return;
      void api
        .getProjectScriptSource(projectId, scriptName)
        .then((res) => {
          if (res.hash === data.hash) return;
          if (!dirty) {
            lastSavedRef.current = res.source;
            setData(res);
            editorRef.current?.setValue(res.source);
            setMeta(res.meta);
            setMetaOk(!res.metaError);
            setProvenance(res.provenance ?? null);
          } else {
            setConflict({ currentHash: res.hash, currentSource: res.source });
          }
        })
        .catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [data, dirty, saving, conflict, projectId, scriptName]);

  // ── Provenance / copy-on-write ──────────────────────────────────────
  const managed = (provenance !== null && !editAnyway) || isStandard;

  const makeOwnCopy = useCallback(async () => {
    const source = editorRef.current?.getValue() ?? data?.source;
    if (!source) return;
    const body = sourceWithoutMarker(source);
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate =
        attempt === 0 ? `${scriptName}-custom` : `${scriptName}-custom-${attempt + 1}`;
      try {
        await api.createProjectScript(projectId, { name: candidate, source: body });
        dropDraft();
        window.dispatchEvent(
          new CustomEvent('gezel:open-tab', {
            detail: { kind: 'script', projectId, name: candidate, activate: true },
          }),
        );
        return;
      } catch (err) {
        if (err instanceof GezelApiError && err.status === 409) continue;
        setSaveError((err as Error).message);
        return;
      }
    }
    setSaveError('could not find a free name for the copy');
  }, [data, dropDraft, projectId, scriptName]);

  // ── Test runs ───────────────────────────────────────────────────────
  const runOnce = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    setLastRun(null);
    setRunDetail(null);
    try {
      if (dirty || saving) {
        const ok = await save();
        if (!ok) return;
      } else if (!metaOk) {
        setRunError('Fix the meta block before running.');
        return;
      }
      let result: RunScriptResponse;
      try {
        result = await api.runProjectScript(projectId, {
          name: scriptName,
          ...(scope ? { scope } : {}),
          input: runValues,
        });
      } catch (err) {
        // Failed runs come back as HTTP 500 with the same structured
        // body — recover it so failures render like results, not like
        // transport errors.
        const details = err instanceof GezelApiError ? err.details : null;
        if (details && typeof details === 'object' && 'runId' in details) {
          result = details as RunScriptResponse;
        } else {
          throw err;
        }
      }
      setLastRun(result);
      void api
        .getProjectScriptRun(projectId, result.runId)
        .then(setRunDetail)
        .catch(() => {});
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [dirty, metaOk, projectId, runValues, save, saving, scope, scriptName]);

  const violatedCapability = detectCapabilityViolation(lastRun?.error);

  const allowCapabilityAndRerun = useCallback(async () => {
    if (!violatedCapability) return;
    const source = editorRef.current?.getValue();
    if (!source) return;
    const next = addCapabilityToSource(source, violatedCapability);
    if (!next) {
      // Couldn't find the requires array — put the cursor on the meta
      // block instead of guessing.
      const line = source.slice(0, source.indexOf('meta')).split('\n').length;
      editorRef.current?.revealLine(Math.max(1, line));
      return;
    }
    setFixingCapability(true);
    try {
      editorRef.current?.setValue(next);
      handleChangeContent(next);
      await runOnce();
    } finally {
      setFixingCapability(false);
    }
  }, [handleChangeContent, runOnce, violatedCapability]);

  // ── Derived ─────────────────────────────────────────────────────────
  const problemCount = useMemo(
    () => problems.filter((p) => p.severity === 'error').length,
    [problems],
  );

  const openScriptsArea = () =>
    window.dispatchEvent(
      new CustomEvent('gezel:open-tab', {
        detail: { kind: 'area', area: 'scripts', activate: true },
      }),
    );

  const openUsage = (usage: StepUsage) =>
    window.dispatchEvent(
      new CustomEvent('gezel:open-tab', {
        detail: { kind: 'task', ref: usage.taskRef, activate: true },
      }),
    );

  if (loadError) {
    return (
      <div className="script-editor-view">
        <p className="scripts-view__error">
          {loadError.includes('404') || loadError.includes('not found')
            ? `Script "${scriptName}" does not exist in this project.`
            : `Error: ${loadError}`}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="script-editor-view">
        <p className="muted small">Loading script…</p>
      </div>
    );
  }

  return (
    <div className="script-editor-view">
      <header className="script-editor-header">
        <button
          type="button"
          className="script-editor-back muted"
          onClick={openScriptsArea}
          title="All scripts"
          aria-label="Back to scripts"
        >
          ‹
        </button>
        <div className="script-editor-title">
          <h1>{scriptName}</h1>
          {meta?.description && <p className="muted small">{meta.description}</p>}
        </div>
        <CapabilityPills requires={meta?.requires} />
        {usages.length > 0 && (
          <button
            type="button"
            className="script-editor-usages muted small"
            onClick={() => openUsage(usages[0]!)}
            title={usages.map((u) => `${u.taskTitle} — ${u.stepName} (on ${u.moment})`).join('\n')}
          >
            Runs on {usages.length} task step{usages.length === 1 ? '' : 's'}
          </button>
        )}
        <div className="script-editor-actions">
          {dirty && (
            <span className="script-editor-dirty small" title="Unsaved changes">
              ● Unsaved
            </span>
          )}
          <button type="button" onClick={() => void save()} disabled={!dirty || saving || managed}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setRail('run');
            }}
          >
            Test run
          </button>
          <button
            type="button"
            className="script-editor-rail-toggle muted"
            onClick={() => setRail((r) => (r === null ? 'about' : null))}
            title={rail === null ? 'Show panel' : 'Hide panel'}
            aria-label={rail === null ? 'Show panel' : 'Hide panel'}
          >
            {rail === null ? '⟨' : '⟩'}
          </button>
        </div>
      </header>

      {aiDrafting === 'busy' && (
        <div className="script-editor-banner script-editor-banner--info">
          <span>Drafting with AI… you can start editing; the draft will replace the buffer.</span>
        </div>
      )}
      {aiDrafting === 'failed' && (
        <div className="script-editor-banner script-editor-banner--warn">
          <span>The AI draft didn't come through — starting from the blank skeleton instead.</span>
          <button type="button" className="muted small" onClick={() => setAiDrafting(null)}>
            Dismiss
          </button>
        </div>
      )}

      {restoredDraft && (
        <div className="script-editor-banner script-editor-banner--info">
          <span>Restored your unsaved changes from last time.</span>
          <button type="button" className="muted small" onClick={discardDraft}>
            Discard them
          </button>
        </div>
      )}

      {conflict && (
        <div className="script-editor-banner script-editor-banner--warn">
          <span>This script changed on disk while you were editing.</span>
          <button type="button" onClick={reloadFromDisk}>
            Reload from disk
          </button>
          <button type="button" onClick={overwriteDisk}>
            Overwrite with my version
          </button>
        </div>
      )}

      {provenance && (
        <div className="script-editor-banner script-editor-banner--warn">
          <span>
            {provenance.kind === 'standard'
              ? 'Standard library — packed into the app and read-only. Duplicate it into this project to customize.'
              : provenance.kind === 'user'
                ? 'From your machine-wide library (~/.gezel/scripts). Edits here apply everywhere it is referenced.'
                : provenance.kind === 'craftbook'
                  ? `Part of the ${provenance.ref} craftbook — updates to the craftbook replace this file, so direct edits would be lost.`
                  : `Generated from import ${provenance.ref} — re-syncing the import replaces this file.`}
          </span>
          {provenance.kind !== 'user' && (
            <button type="button" onClick={() => void makeOwnCopy()}>
              {provenance.kind === 'standard' ? 'Duplicate into this project' : 'Make my own copy'}
            </button>
          )}
          {!editAnyway && provenance.kind !== 'standard' && provenance.kind !== 'user' && (
            <button type="button" className="muted" onClick={() => setConfirmEditAnyway(true)}>
              Edit anyway
            </button>
          )}
        </div>
      )}

      {!metaOk && (
        <div className="script-editor-banner script-editor-banner--warn">
          Saved, but the meta block is invalid — this script is hidden from lists and can't run
          until it's fixed.
        </div>
      )}

      {saveError && (
        <div className="script-editor-banner script-editor-banner--error">
          Save failed: {saveError}
        </div>
      )}

      <div className="script-editor-body">
        <ScriptEditorTabs
          ref={editorRef}
          projectId={projectId}
          scriptName={scriptName}
          initialSource={data.source}
          initialMeta={meta}
          readOnly={managed}
          onChangeContent={handleChangeContent}
          onSave={() => void save()}
          onProblems={setProblems}
          onReady={() => {
            if (serverDiagnostics.length > 0) {
              editorRef.current?.setServerDiagnostics(serverDiagnostics);
            }
          }}
        />
        {rail !== null && (
          <aside className="script-editor-rail">
            <Tabs.Root value={rail} onValueChange={(v) => setRail(v as 'about' | 'run')}>
              <Tabs.List aria-label="Script panel">
                <Tabs.Trigger value="about">About</Tabs.Trigger>
                <Tabs.Trigger value="run">Test run</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="about">
                <AboutPanel meta={meta} provenance={provenance} usages={usages} />
              </Tabs.Content>
              <Tabs.Content value="run">
                <div className="script-editor-run">
                  {meta?.inputs && Object.keys(meta.inputs).length > 0 && (
                    <fieldset className="script-detail__inputs">
                      <legend>Inputs</legend>
                      <ScriptInputFields
                        inputs={meta.inputs}
                        values={runValues}
                        onChange={setRunValues}
                      />
                    </fieldset>
                  )}
                  <div className="script-detail__actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={running || saving || managed}
                      onClick={() => void runOnce()}
                    >
                      {running ? 'Running…' : dirty ? 'Save & run' : 'Run'}
                    </button>
                  </div>
                  {runError && <p className="scripts-view__error">{runError}</p>}
                  {lastRun && violatedCapability && (
                    <div className="script-editor-capfix">
                      <p>
                        <strong>
                          This script tried to use “{capabilityLabel(violatedCapability)}”, but it
                          isn't allowed to yet.
                        </strong>
                      </p>
                      <p className="muted small">
                        Scripts can only use what they declare up front in their meta block.
                      </p>
                      <button
                        type="button"
                        className="primary"
                        disabled={fixingCapability}
                        onClick={() => void allowCapabilityAndRerun()}
                      >
                        {fixingCapability
                          ? 'Updating…'
                          : `Allow “${capabilityLabel(violatedCapability)}” and run again`}
                      </button>
                    </div>
                  )}
                  {lastRun && meta && <RunResult result={lastRun} meta={meta} />}
                  {runDetail?.logs && (
                    <section className="script-editor-logs">
                      <h4>Log</h4>
                      <pre>{runDetail.logs}</pre>
                    </section>
                  )}
                </div>
              </Tabs.Content>
            </Tabs.Root>
          </aside>
        )}
      </div>

      {problems.length > 0 && (
        <footer className="script-editor-problems">
          <strong className="small">
            Problems (
            {problemCount > 0
              ? `${problemCount} error${problemCount === 1 ? '' : 's'}`
              : problems.length}
            )
          </strong>
          <ul>
            {problems.slice(0, 50).map((p, i) => (
              <li key={`${p.line}:${p.column}:${i}`}>
                <button
                  type="button"
                  className={`script-editor-problem script-editor-problem--${p.severity}`}
                  onClick={() => editorRef.current?.revealLine(p.line)}
                >
                  <span className="script-editor-problem-msg">{p.message}</span>
                  <span className="muted small">line {p.line}</span>
                </button>
              </li>
            ))}
          </ul>
        </footer>
      )}

      <ConfirmDialog
        open={confirmEditAnyway}
        title="Edit a managed script?"
        message="This file is replaced wholesale when its craftbook or import updates — your edits would be lost then. Making your own copy is the safe way to customize it."
        confirmLabel="Edit anyway"
        danger
        onConfirm={() => {
          setEditAnyway(true);
          setConfirmEditAnyway(false);
        }}
        onCancel={() => setConfirmEditAnyway(false)}
      />
    </div>
  );
}

function AboutPanel({
  meta,
  provenance,
  usages,
}: {
  meta: ScriptMeta | undefined;
  provenance: ScriptProvenance | null;
  usages: StepUsage[];
}) {
  if (!meta) {
    return (
      <p className="muted small">
        This script's meta block doesn't parse yet, so there's nothing to summarize. Fix the
        problems listed below the editor.
      </p>
    );
  }
  return (
    <div className="script-editor-about">
      <p>{meta.description}</p>
      {meta.inputs && Object.keys(meta.inputs).length > 0 && (
        <section>
          <h4>Takes</h4>
          <ul>
            {Object.entries(meta.inputs).map(([name, field]) => (
              <li key={name}>
                <code>{name}</code> — {field.description}
                {field.required ? ' (required)' : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      {meta.outputs && Object.keys(meta.outputs).length > 0 && (
        <section>
          <h4>Produces</h4>
          <ul>
            {Object.entries(meta.outputs).map(([name, field]) => (
              <li key={name}>
                <code>{name}</code> — {field.description}
              </li>
            ))}
          </ul>
        </section>
      )}
      {meta.requires && meta.requires.length > 0 && (
        <section>
          <h4>Allowed to</h4>
          <ul>
            {meta.requires.map((cap) => (
              <li key={cap}>
                {capabilityLabel(cap)} <code className="muted small">{cap}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4>Origin</h4>
        <p className="muted small">
          {provenance
            ? provenance.kind === 'standard'
              ? `Standard library (${provenance.ref}) — ships with the app.`
              : provenance.kind === 'user'
                ? 'Your machine-wide library (~/.gezel/scripts).'
                : provenance.kind === 'craftbook'
                  ? `Installed by the ${provenance.ref} craftbook.`
                  : `Generated from import ${provenance.ref}.`
            : 'A script of this project.'}
        </p>
      </section>
      {usages.length > 0 && (
        <section>
          <h4>Used by</h4>
          <ul>
            {usages.map((u) => (
              <li key={`${u.taskRef}:${u.stepName}:${u.moment}`}>
                {u.taskTitle} — {u.stepName} (on {u.moment})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
