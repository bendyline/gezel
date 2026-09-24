import {
  type CraftbookInputParam,
  type TaskInputSkipReason,
  type TaskInputSource,
  formatInputBytes,
  inputAccepts,
} from '@bendyline/gezel';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { apiErrorMessage } from '../../api-error.js';
import { api } from '../../api.js';
import {
  type FilteredPick,
  type PickedSet,
  filterPick,
  pickFromDirectoryInput,
  pickFromDrop,
  pickFromFileInput,
} from './pick-files.js';

/** What the launcher knows about one input: what to send, and what to show. */
export interface CraftbookInputValue {
  source: TaskInputSource | null;
  label?: string;
  fileCount?: number;
  totalBytes?: number;
  skipped?: Array<{ path: string; reason: TaskInputSkipReason }>;
  /** Checking or uploading — Create waits. */
  busy?: boolean;
  /** Uploaded so far, while `busy` with an upload. */
  progress?: { done: number; total: number };
  error?: string;
}

export const EMPTY_INPUT_VALUE: CraftbookInputValue = { source: null };

const SKIP_REASON_COPY: Record<TaskInputSkipReason, string> = {
  'not-accepted': 'not a type this craftbook reads',
  'sync-junk': 'system file',
  'too-large': 'too large',
  'over-file-limit': 'over the file limit',
  'over-byte-limit': 'over the size limit',
  unreadable: 'could not be read',
};

type SourceMode = 'project' | 'computer';

interface WorkspaceEntry {
  path: string;
  name: string;
  depth: number;
}

/**
 * The source picker for one craftbook input — the files a run works on.
 * "In this project" points at a workspace folder or file, read where it is;
 * "From your computer" uploads what the user picks into a staging area the
 * task adopts at launch. The upload runs in the browser, so it works the
 * same in the desktop app and in a plain browser tab.
 */
export function CraftbookInputField({
  projectId,
  craftbookId,
  craftbookVersion,
  input,
  allowUpload,
  value,
  onChange,
}: {
  projectId: string;
  craftbookId: string;
  craftbookVersion?: string;
  input: CraftbookInputParam;
  /** False for a recurring schedule: one-off picked files cannot recur. */
  allowUpload: boolean;
  value: CraftbookInputValue;
  onChange: (next: CraftbookInputValue) => void;
}) {
  const [mode, setMode] = useState<SourceMode>(
    value.source?.from === 'upload' ? 'computer' : 'project',
  );
  const [browsing, setBrowsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const isFolder = input.spec.kind === 'folder';
  const noun = isFolder ? 'folder' : 'file';
  const acceptAttr = input.spec.accept?.join(',');

  useEffect(() => () => uploadAbort.current?.abort(), []);

  const discardUpload = (source: TaskInputSource | null) => {
    if (source?.from === 'upload') {
      void api.taskInputs.deleteInputStaging(projectId, source.stagingId).catch(() => {});
    }
  };

  const chooseMode = (next: SourceMode) => {
    if (next === mode) return;
    uploadAbort.current?.abort();
    discardUpload(valueRef.current.source);
    setMode(next);
    setBrowsing(false);
    onChange(EMPTY_INPUT_VALUE);
  };

  const chooseWorkspacePath = async (path: string, label: string) => {
    setBrowsing(false);
    const source: TaskInputSource = { from: 'workspace', path };
    onChange({ source, label, busy: true });
    try {
      const preview = await api.taskInputs.previewTaskInput(projectId, {
        craftbookId,
        ...(craftbookVersion ? { craftbookVersion } : {}),
        param: input.key,
        source,
      });
      onChange(
        preview.error
          ? { source: null, label, error: preview.error }
          : {
              source,
              label: preview.label || label,
              fileCount: preview.fileCount,
              totalBytes: preview.totalBytes,
              skipped: preview.skipped,
            },
      );
    } catch {
      // The preview is advisory and the launch re-checks, so a failed
      // preview keeps the choice rather than blocking it.
      onChange({ source, label });
    }
  };

  const upload = async (pick: PickedSet) => {
    uploadAbort.current?.abort();
    discardUpload(valueRef.current.source);
    const filtered: FilteredPick = filterPick(input.spec, pick);
    if (filtered.error) {
      onChange({
        source: null,
        label: filtered.label,
        error: filtered.error,
        skipped: filtered.skipped,
      });
      return;
    }
    const abort = new AbortController();
    uploadAbort.current = abort;
    const total = filtered.accepted.length;
    onChange({ source: null, label: filtered.label, busy: true, progress: { done: 0, total } });
    let stagingId: string | null = null;
    try {
      const staged = await api.taskInputs.createInputStaging(projectId, {
        craftbookId,
        ...(craftbookVersion ? { craftbookVersion } : {}),
        param: input.key,
        label: filtered.label,
      });
      stagingId = staged.stagingId;
      let done = 0;
      for (const picked of filtered.accepted) {
        if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
        await api.taskInputs.uploadInputStagingFile(
          projectId,
          staged.stagingId,
          picked.relPath,
          picked.file,
          abort.signal,
        );
        done += 1;
        onChange({ source: null, label: filtered.label, busy: true, progress: { done, total } });
      }
      onChange({
        source: { from: 'upload', stagingId: staged.stagingId },
        label: filtered.label,
        fileCount: total,
        totalBytes: filtered.totalBytes,
        skipped: filtered.skipped,
      });
    } catch (err) {
      if (stagingId) void api.taskInputs.deleteInputStaging(projectId, stagingId).catch(() => {});
      if (abort.signal.aborted) return;
      onChange({ source: null, label: filtered.label, error: apiErrorMessage(err) });
    } finally {
      if (uploadAbort.current === abort) uploadAbort.current = null;
    }
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const pick = await pickFromDrop(e.dataTransfer.items).catch(() => null);
    if (pick && pick.files.length > 0) await upload(pick);
  };

  const summary = describeValue(value, noun);

  return (
    <div className="gz-cbi">
      <div className="gz-cbi-head">
        <span className="gz-cbi-title">
          {input.title}
          {!input.required && <span className="muted"> · optional</span>}
        </span>
        {input.description && <span className="gz-cbi-help">{input.description}</span>}
      </div>
      <div
        className="gz-tray gz-cbi-tray"
        role="radiogroup"
        aria-label={`Where the ${input.title.toLowerCase()} comes from`}
      >
        <button
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons is the shared keys-in-trays pattern.
          role="radio"
          aria-checked={mode === 'project'}
          className={`gz-key${mode === 'project' ? ' gz-key-active' : ''}`}
          onClick={() => chooseMode('project')}
        >
          In this project
        </button>
        <button
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons is the shared keys-in-trays pattern.
          role="radio"
          aria-checked={mode === 'computer'}
          className={`gz-key${mode === 'computer' ? ' gz-key-active' : ''}`}
          onClick={() => chooseMode('computer')}
          disabled={!allowUpload}
          title={
            allowUpload ? undefined : 'A recurring task reads its files from the project each run.'
          }
        >
          From your computer
        </button>
      </div>

      {mode === 'project' ? (
        <div className="gz-cbi-body">
          <div className="gz-cbi-row">
            <button type="button" onClick={() => setBrowsing((v) => !v)} aria-expanded={browsing}>
              {value.source?.from === 'workspace' ? `Change ${noun}…` : `Choose a ${noun}…`}
            </button>
            {summary && <span className="gz-cbi-summary">{summary}</span>}
          </div>
          {browsing && (
            <WorkspacePicker
              projectId={projectId}
              input={input}
              selected={value.source?.from === 'workspace' ? value.source.path : null}
              onPick={(path, label) => void chooseWorkspacePath(path, label)}
            />
          )}
        </div>
      ) : (
        <div
          className={`gz-cbi-body gz-cbi-drop${dragOver ? ' gz-cbi-drop--over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => void onDrop(e)}
        >
          <div className="gz-cbi-row">
            {isFolder && (
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                disabled={value.busy}
              >
                Choose folder…
              </button>
            )}
            <button
              type="button"
              onClick={() => filesInputRef.current?.click()}
              disabled={value.busy}
            >
              {isFolder ? 'Choose files…' : 'Choose file…'}
            </button>
            <span className="gz-cbi-summary">
              {summary ?? `or drop ${isFolder ? 'a folder or files' : 'a file'} here`}
            </span>
          </div>
          {value.busy && value.progress && (
            <progress
              className="gz-cbi-progress"
              max={value.progress.total}
              value={value.progress.done}
              aria-label="Upload progress"
            />
          )}
          <input
            ref={folderInputRef}
            type="file"
            hidden
            // React has no typed prop for these; both engines honour them.
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(e) => {
              if (e.target.files?.length) void upload(pickFromDirectoryInput(e.target.files));
              e.target.value = '';
            }}
          />
          <input
            ref={filesInputRef}
            type="file"
            hidden
            multiple={isFolder}
            {...(acceptAttr ? { accept: acceptAttr } : {})}
            onChange={(e) => {
              if (e.target.files?.length) void upload(pickFromFileInput(e.target.files));
              e.target.value = '';
            }}
          />
        </div>
      )}

      {value.error && (
        <p className="error small gz-cbi-error" role="alert">
          {value.error}
        </p>
      )}
      {value.skipped && value.skipped.length > 0 && (
        <details className="gz-cbi-skipped">
          <summary>
            {value.skipped.length} file{value.skipped.length === 1 ? '' : 's'} left out
          </summary>
          <ul>
            {value.skipped.slice(0, 50).map((s) => (
              <li key={s.path}>
                <span className="gz-cbi-path">{s.path}</span> — {SKIP_REASON_COPY[s.reason]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function describeValue(value: CraftbookInputValue, noun: string): string | null {
  if (value.busy) {
    return value.progress
      ? `Uploading ${value.progress.done} of ${value.progress.total}…`
      : `Checking ${value.label ?? noun}…`;
  }
  if (!value.source || value.fileCount === undefined)
    return value.source ? (value.label ?? null) : null;
  const files = `${value.fileCount} file${value.fileCount === 1 ? '' : 's'}`;
  const size = value.totalBytes !== undefined ? ` · ${formatInputBytes(value.totalBytes)}` : '';
  return `${value.label ?? ''} — ${files}${size}`;
}

/**
 * The workspace, flattened into an indented list of the folders (or, for a
 * single-file input, the accepted files) a source can be. The listing is the
 * recursive workspace walk — capped server-side, so an enormous tree says so
 * rather than hanging the dialog.
 */
function WorkspacePicker({
  projectId,
  input,
  selected,
  onPick,
}: {
  projectId: string;
  input: CraftbookInputParam;
  selected: string | null;
  onPick: (path: string, label: string) => void;
}) {
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [typedPath, setTypedPath] = useState('');
  const isFolder = input.spec.kind === 'folder';
  const applyTypedPath = () => {
    const path = typedPath.trim();
    if (path) onPick(path, path.split('/').pop() || path);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.listProjectWorkspace(projectId, undefined, true);
        if (cancelled) return;
        const rows = res.files
          .filter((f) =>
            isFolder ? f.isDirectory : !f.isDirectory && inputAccepts(input.spec, f.path),
          )
          .map((f) => ({ path: f.path, name: f.name, depth: f.path.split('/').length - 1 }))
          .sort((a, b) => a.path.localeCompare(b.path));
        setEntries(isFolder ? [{ path: '.', name: 'Whole project', depth: 0 }, ...rows] : rows);
        setTruncated(res.truncated === true);
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, isFolder, input.spec]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!entries) return [];
    return q ? entries.filter((e) => e.path.toLowerCase().includes(q)) : entries;
  }, [entries, filter]);

  if (error) return <p className="error small gz-cbi-error">{error}</p>;
  if (!entries) return <p className="muted small">Loading the project’s files…</p>;
  if (entries.length === 0) {
    return (
      <p className="muted small">
        {isFolder
          ? 'This project has no folders yet.'
          : 'No file here is a type this craftbook reads.'}
      </p>
    );
  }

  return (
    <div className="gz-cbi-picker">
      {entries.length > 12 && (
        <input
          type="search"
          className="gz-cbi-filter"
          placeholder={isFolder ? 'Filter folders' : 'Filter files'}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <fieldset className="gz-cbi-list" aria-label={isFolder ? 'Project folders' : 'Project files'}>
        {visible.map((entry) => {
          const active = entry.path === selected;
          return (
            <button
              key={entry.path}
              type="button"
              aria-pressed={active}
              className={`gz-cbi-node${active ? ' active' : ''}`}
              style={{ paddingLeft: `${0.5 + (filter ? 0 : entry.depth) * 0.9}rem` }}
              onClick={() => onPick(entry.path, entry.path === '.' ? 'Whole project' : entry.name)}
              title={entry.path}
            >
              {filter ? entry.path : entry.name}
            </button>
          );
        })}
      </fieldset>
      {truncated && (
        // Not a <form>: the launcher around this field already is one.
        <div className="gz-cbi-row">
          <input
            type="text"
            className="gz-cbi-filter"
            placeholder="Not listed? Type its path, e.g. notes/drafts"
            value={typedPath}
            onChange={(e) => setTypedPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              applyTypedPath();
            }}
          />
          <button type="button" onClick={applyTypedPath} disabled={!typedPath.trim()}>
            Use
          </button>
        </div>
      )}
    </div>
  );
}
