import type { GetScriptSourceResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import type { RecentTabInput } from '../components/recent-tabs.js';
import type { EditorProblem } from '../components/script-editor/ScriptCodeEditor.js';
import {
  ScriptEditorTabs,
  type ScriptEditorTabsHandle,
} from '../components/script-editor/ScriptEditorTabs.js';

interface CraftbookScriptEditorViewProps {
  craftbookId: string;
  scriptName: string;
}

/**
 * Monaco editor for a script BUNDLED inside a craftbook template. Reuses
 * the shared `ScriptCodeEditor` (same `gezel.*` IntelliSense + diagnostics
 * as the project script editor — it only needs a unique model uri, here
 * keyed by craftbook id). If the script doesn't exist yet (the step panel's
 * "attach script" just minted the ref), it's scaffolded on first open.
 */
export function CraftbookScriptEditorView({
  craftbookId,
  scriptName,
}: CraftbookScriptEditorViewProps) {
  const editorRef = useRef<ScriptEditorTabsHandle | null>(null);
  const [data, setData] = useState<GetScriptSourceResponse | null>(null);
  const [problems, setProblems] = useState<EditorProblem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const returnToCraftbook = () => {
    setConfirmLeave(false);
    window.dispatchEvent(
      new CustomEvent<RecentTabInput>('gezel:open-tab', {
        detail: { kind: 'craftbook', id: craftbookId },
      }),
    );
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let res = await api.getCraftbookScriptSource(craftbookId, scriptName).catch(() => null);
        if (!res) {
          // Not created yet — scaffold it, then load.
          await api.createCraftbookScript(craftbookId, { name: scriptName });
          res = await api.getCraftbookScriptSource(craftbookId, scriptName);
        }
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [craftbookId, scriptName]);

  const save = useCallback(async () => {
    const source = editorRef.current?.getValue();
    if (source == null || !data) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveCraftbookScriptSource(craftbookId, {
        name: scriptName,
        source,
        baseHash: data.hash,
      });
      if (res.status === 'conflict') {
        setError('The script changed on disk — reopen the tab to get the latest.');
        return;
      }
      setData({ ...data, source, hash: res.hash });
      setDirty(editorRef.current?.getValue() !== source);
      editorRef.current?.setServerDiagnostics(res.diagnostics);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [craftbookId, scriptName, data]);

  const errorCount = problems.filter((p) => p.severity === 'error').length;

  return (
    <div className="script-editor-view">
      <header className="script-editor-header">
        <button
          type="button"
          className="secondary"
          disabled={saving}
          onClick={() => {
            if (dirty) setConfirmLeave(true);
            else returnToCraftbook();
          }}
        >
          Back to plan
        </button>
        <div className="script-editor-title">
          <span className="task-ref">{craftbookId}</span>
          <h3>{scriptName}</h3>
          {dirty && <span className="muted small">• unsaved</span>}
        </div>
        <div className="script-editor-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={saving || !data || !dirty}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>
      {error && <p className="error small">{error}</p>}
      {data && (
        <div className="script-editor-body">
          <ScriptEditorTabs
            ref={editorRef}
            projectId={`craftbook:${craftbookId}`}
            scriptName={scriptName}
            initialSource={data.source}
            initialMeta={data.meta}
            onChangeContent={(source) => setDirty(source !== data.source)}
            onSave={() => void save()}
            onProblems={setProblems}
          />
        </div>
      )}
      {errorCount > 0 && (
        <div className="script-editor-problems small">
          {errorCount} problem{errorCount === 1 ? '' : 's'} — hover the red marks in the editor.
        </div>
      )}
      <ConfirmDialog
        open={confirmLeave}
        title="Discard unsaved changes?"
        message="Your script has unsaved changes. Keep editing to save them, or discard them and return to the plan."
        confirmLabel="Discard changes and return"
        cancelLabel="Keep editing"
        danger
        onConfirm={returnToCraftbook}
        onCancel={() => setConfirmLeave(false)}
      />
    </div>
  );
}
