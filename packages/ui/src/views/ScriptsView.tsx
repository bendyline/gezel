import type { ListScriptsResponse, Project, RunScriptResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { CapabilityPills } from '../components/CapabilityPills.js';
import { NewScriptDialog } from '../components/NewScriptDialog.js';
import { RunResult, ScriptInputFields, buildDefaultInputs } from '../components/ScriptRunForm.js';

type ScriptEntry = ListScriptsResponse['scripts'][number];

/**
 * Sentinel for the cross-project library in the source picker. The
 * library is the `user` resolution scope (~/.gezel/scripts) — scripts
 * there belong to no single project and any project's task steps can
 * attach them, which is what makes it the place to put anything shared.
 */
const SHARED_LIBRARY = 'shared-library';

/**
 * Shared scripts still need a project to run *in* — the runner scopes a
 * run's workspace, artifacts and run record to one. Absent a pinned
 * project we use `default`, the bucket every install already has.
 */
const SHARED_RUN_PROJECT = 'default';

export interface ScriptsViewProps {
  /** Pin to a single project (used by the per-project view). */
  projectId?: string;
}

export function ScriptsView({ projectId }: ScriptsViewProps = {}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [source, setSource] = useState<string>(projectId ?? SHARED_LIBRARY);
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunScriptResponse | null>(null);
  const [creating, setCreating] = useState(false);

  const shared = source === SHARED_LIBRARY;
  const runProjectId = shared ? (projectId ?? SHARED_RUN_PROJECT) : source;

  useEffect(() => {
    if (projectId !== undefined) {
      setSource(projectId);
      return;
    }
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch((err) => setError((err as Error).message));
  }, [projectId]);

  const refresh = useCallback(async (src: string) => {
    try {
      const res =
        src === SHARED_LIBRARY
          ? await api.listUserScripts()
          : src
            ? await api.listProjectScripts(src)
            : { scripts: [] };
      setScripts(res.scripts);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh(source);
  }, [source, refresh]);

  // Keep a script selected at all times — the picker offers no "pick one"
  // placeholder, so the first entry stands in until the user chooses.
  useEffect(() => {
    setSelected((current) =>
      current && scripts.some((s) => s.name === current) ? current : (scripts[0]?.name ?? null),
    );
  }, [scripts]);

  const selectedScript = useMemo(
    () => scripts.find((s) => s.name === selected) ?? null,
    [scripts, selected],
  );

  // Reset form + last run whenever the selection changes.
  useEffect(() => {
    if (!selectedScript) {
      setInputValues({});
      setLastRun(null);
      return;
    }
    setInputValues(buildDefaultInputs(selectedScript.meta));
    setLastRun(null);
  }, [selectedScript]);

  const runSelected = useCallback(async () => {
    if (!selectedScript) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.runProjectScript(runProjectId, {
        name: selectedScript.name,
        ...(shared ? { scope: 'user' as const } : {}),
        input: inputValues,
      });
      setLastRun(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [selectedScript, runProjectId, shared, inputValues]);

  const openEditor = useCallback(
    (name: string) => {
      window.dispatchEvent(
        new CustomEvent('gezel:open-tab', {
          detail: {
            kind: 'script',
            projectId: runProjectId,
            name,
            ...(shared ? { scope: 'user' as const } : {}),
            activate: true,
          },
        }),
      );
    },
    [runProjectId, shared],
  );

  return (
    <div className="scripts-view" data-testid="scripts-view">
      <header className="scripts-view__header">
        <h1>Scripts</h1>
        <div className="scripts-view__toolbar">
          {projectId === undefined && (
            <label className="scripts-view__field">
              <span>Scripts from</span>
              <select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setSelected(null);
                }}
              >
                <option value={SHARED_LIBRARY}>Shared library</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="scripts-view__field">
            <span>Script</span>
            <select
              value={selected ?? ''}
              disabled={scripts.length === 0}
              onChange={(e) => setSelected(e.target.value || null)}
            >
              {scripts.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.meta.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary scripts-view__new"
            onClick={() => setCreating(true)}
          >
            New script
          </button>
        </div>
      </header>

      {error && <p className="scripts-view__error">Error: {error}</p>}

      <div className="scripts-view__detail">
        {scripts.length === 0 ? (
          <p className="scripts-view__empty">
            {shared
              ? 'No shared scripts yet. Scripts here belong to no single project — every project can run them — so this is the place for anything more than one job needs.'
              : 'No scripts yet. Scripts are small automations that run when task phases start or finish — create one to get going.'}
          </p>
        ) : selectedScript ? (
          <ScriptDetail
            entry={selectedScript}
            shared={shared}
            inputValues={inputValues}
            onInputChange={setInputValues}
            running={running}
            onRun={runSelected}
            onEdit={() => openEditor(selectedScript.name)}
            lastRun={lastRun}
          />
        ) : null}
      </div>

      <NewScriptDialog
        open={creating}
        projectId={runProjectId}
        {...(shared ? { scope: 'user' as const } : {})}
        onClose={() => setCreating(false)}
        onCreated={(name) => {
          setCreating(false);
          void refresh(source);
          setSelected(name);
          openEditor(name);
        }}
      />
    </div>
  );
}

function ScriptDetail({
  entry,
  shared,
  inputValues,
  onInputChange,
  running,
  onRun,
  onEdit,
  lastRun,
}: {
  entry: ScriptEntry;
  shared: boolean;
  inputValues: Record<string, unknown>;
  onInputChange: (next: Record<string, unknown>) => void;
  running: boolean;
  onRun: () => void;
  onEdit: () => void;
  lastRun: RunScriptResponse | null;
}) {
  const meta = entry.meta;
  return (
    <div className="script-detail">
      <header>
        <h2>{meta.name}</h2>
        <p>{meta.description}</p>
        {shared && <p className="muted small">In the shared library — every project can run it.</p>}
        <CapabilityPills requires={meta.requires} />
      </header>

      {meta.inputs && Object.keys(meta.inputs).length > 0 && (
        <fieldset className="script-detail__inputs">
          <legend>Inputs</legend>
          <ScriptInputFields inputs={meta.inputs} values={inputValues} onChange={onInputChange} />
        </fieldset>
      )}

      {meta.outputs && Object.keys(meta.outputs).length > 0 && (
        <section className="script-detail__outputs">
          <h3>Declared outputs</h3>
          <ul>
            {Object.entries(meta.outputs).map(([name, o]) => (
              <li key={name}>
                <code>{name}</code>: <em>{o.type}</em> — {o.description}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="script-detail__actions">
        <button type="button" disabled={running} onClick={onRun}>
          {running ? 'Running…' : 'Run'}
        </button>
        <button type="button" onClick={onEdit}>
          Edit code
        </button>
      </div>

      {lastRun && <RunResult result={lastRun} meta={meta} />}
    </div>
  );
}
