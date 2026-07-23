import type { ListScriptsResponse, Project, RunScriptResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { CapabilityPills } from '../components/CapabilityPills.js';
import { NewScriptDialog } from '../components/NewScriptDialog.js';
import { RunResult, ScriptInputFields, buildDefaultInputs } from '../components/ScriptRunForm.js';

type ScriptEntry = ListScriptsResponse['scripts'][number];

export interface ScriptsViewProps {
  /** Pin to a single project (used by the per-project view). */
  projectId?: string;
}

export function ScriptsView({ projectId }: ScriptsViewProps = {}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectFilter, setProjectFilter] = useState(projectId ?? '');
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunScriptResponse | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (projectId !== undefined) {
      setProjectFilter(projectId);
      return;
    }
    api
      .listProjects()
      .then((r) => {
        setProjects(r.projects);
        if (!projectFilter && r.projects[0]) setProjectFilter(r.projects[0].id);
      })
      .catch((err) => setError((err as Error).message));
  }, [projectId, projectFilter]);

  const refresh = useCallback(async (pid: string) => {
    if (!pid) {
      setScripts([]);
      return;
    }
    try {
      const res = await api.listProjectScripts(pid);
      setScripts(res.scripts);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (projectFilter) void refresh(projectFilter);
  }, [projectFilter, refresh]);

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
    if (!selectedScript || !projectFilter) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.runProjectScript(projectFilter, {
        name: selectedScript.name,
        input: inputValues,
      });
      setLastRun(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [selectedScript, projectFilter, inputValues]);

  const openEditor = useCallback(
    (name: string) => {
      if (!projectFilter) return;
      window.dispatchEvent(
        new CustomEvent('gezel:open-tab', {
          detail: { kind: 'script', projectId: projectFilter, name, activate: true },
        }),
      );
    },
    [projectFilter],
  );

  return (
    <div className="scripts-view" data-testid="scripts-view">
      <header className="scripts-view__header">
        <h1>Scripts</h1>
        <div className="scripts-view__toolbar">
          {projectId === undefined && (
            <label className="scripts-view__field">
              <span>Project</span>
              <select
                value={projectFilter}
                onChange={(e) => {
                  setProjectFilter(e.target.value);
                  setSelected(null);
                }}
              >
                <option value="">— pick —</option>
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
              disabled={!projectFilter || scripts.length === 0}
              onChange={(e) => setSelected(e.target.value || null)}
            >
              <option value="">{scripts.length === 0 ? '— none —' : '— pick —'}</option>
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
            disabled={!projectFilter}
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
            No scripts yet. Scripts are small automations that run when task phases start or finish
            — create one to get going.
          </p>
        ) : selectedScript ? (
          <ScriptDetail
            entry={selectedScript}
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
        projectId={projectFilter}
        onClose={() => setCreating(false)}
        onCreated={(name) => {
          setCreating(false);
          void refresh(projectFilter);
          openEditor(name);
        }}
      />
    </div>
  );
}

function ScriptDetail({
  entry,
  inputValues,
  onInputChange,
  running,
  onRun,
  onEdit,
  lastRun,
}: {
  entry: ScriptEntry;
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
