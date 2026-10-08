import {
  type InferProjectForPathResponse,
  describeFolderNightWork,
  folderCrewRoles,
  forbiddenFolderPlainName,
} from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';
import { folderCensusLine } from './folder-census-text.js';
import { navigateToTab } from './nav-actions.js';
import { requestProjectSection } from './pending-project-section.js';

/** Fired by every "Add a folder" entry point; the sheet is mounted once, in the app shell. */
export const OPEN_ADD_FOLDER_EVENT = 'gezel:add-folder';

/** Open the add-folder sheet, optionally on a folder already chosen (a drop, a Dock open). */
export function openAddFolder(path?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_ADD_FOLDER_EVENT, { detail: { path } }));
}

type Preview =
  | { state: 'idle' }
  | { state: 'loading'; path: string }
  | { state: 'ready'; path: string; preview: InferProjectForPathResponse }
  | { state: 'refused'; path: string; message: string };

/**
 * One step from "this folder" to a folder the crew looks after. Previews what
 * gezel would make of it — its kind, what it holds, what the crew will do
 * tonight — and adds it read-only with its crew. The overnight switch is on by
 * default; turning it off still adds the folder, with no night work armed.
 */
export function AddFolderSheet() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview>({ state: 'idle' });
  const [overnight, setOvernight] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setPreview({ state: 'loading', path });
    setError(null);
    try {
      const res = await api.inferProjectForPath({ path, kind: 'folder', create: false });
      setPreview({ state: 'ready', path, preview: res });
    } catch (err) {
      setPreview({ state: 'refused', path, message: refusalMessage(err) });
    }
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      setOpen(true);
      setOvernight(true);
      setError(null);
      if (path) void load(path);
      else setPreview({ state: 'idle' });
    };
    window.addEventListener(OPEN_ADD_FOLDER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ADD_FOLDER_EVENT, onOpen);
  }, [load]);

  const choose = async () => {
    const path = await window.__GEZEL__?.selectDirectory?.({ title: 'Add a folder' });
    if (path) void load(path);
  };

  const add = async () => {
    if (preview.state !== 'ready') return;
    setAdding(true);
    setError(null);
    try {
      const res = await api.inferProjectForPath({
        path: preview.path,
        kind: 'folder',
        source: 'add-folder',
        create: true,
        recruitCrew: true,
        nightWork: overnight,
      });
      setOpen(false);
      if (res.project) {
        requestProjectSection(res.project.id, 'overview');
        navigateToTab({ kind: 'project', id: res.project.id });
      }
    } catch (err) {
      setError(refusalMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const ready = preview.state === 'ready' ? preview.preview : null;
  const existing = ready?.matchedBy === 'existing' ? ready.project : null;
  const kind = ready?.folder?.kind;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="add-folder-sheet" aria-describedby={undefined}>
          <Dialog.Title asChild>
            <h2>Add a folder</h2>
          </Dialog.Title>
          {preview.state === 'idle' && (
            <p className="muted">
              Pick a folder for your crew to look after: your photos, your documents, a project
              you're working on.
            </p>
          )}
          {preview.state === 'loading' && <p className="muted">Looking at {preview.path}…</p>}
          {preview.state === 'refused' && <p className="error">{preview.message}</p>}
          {ready && existing && (
            <p>
              <strong>{existing.name}</strong> already looks after this folder.
            </p>
          )}
          {ready && !existing && (
            <div className="add-folder-preview">
              <div className="add-folder-heading">
                <span className="add-folder-name">{ready.name ?? ready.root}</span>
                <span className="add-folder-badge">Read-only folder</span>
              </div>
              {ready.root && <div className="add-folder-path">{ready.root}</div>}
              {ready.folder && (
                <p className="add-folder-census">
                  {folderCensusLine(ready.folder.census, ready.folder.kind)}
                </p>
              )}
              <p className="add-folder-promise">
                Gezel reads and indexes this folder. It never changes, moves or deletes a file
                unless you ask and approve.
              </p>
              {ready.folder && ready.folder.census.cloudOnly > 0 && (
                <p className="add-folder-note">
                  Files stored only in the cloud are listed by name and date and left in the cloud,
                  so gezel never downloads them. Download them to have your crew read them.
                </p>
              )}
              {kind && (
                <>
                  <div className="add-folder-eyebrow">
                    Tonight your {folderCrewRoles(kind).join(' and ')} will
                  </div>
                  <ul className="add-folder-night">
                    {describeFolderNightWork(kind).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              <label className="add-folder-switch">
                <input
                  type="checkbox"
                  checked={overnight}
                  onChange={(e) => setOvernight(e.target.checked)}
                  disabled={adding}
                />
                <span>Work on this folder overnight</span>
              </label>
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <Dialog.Actions>
            <Dialog.Close asChild>
              <button type="button" className="secondary" disabled={adding}>
                Cancel
              </button>
            </Dialog.Close>
            {window.__GEZEL__?.selectDirectory && preview.state !== 'loading' && (
              <button
                type="button"
                className="secondary"
                onClick={() => void choose()}
                disabled={adding}
              >
                {preview.state === 'idle' ? 'Choose a folder…' : 'Choose another…'}
              </button>
            )}
            {existing ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigateToTab({ kind: 'project', id: existing.id });
                }}
              >
                Open it
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void add()}
                disabled={adding || preview.state !== 'ready'}
              >
                {adding ? 'Adding…' : 'Add folder'}
              </button>
            )}
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A refusal in the person's words: gezel never owns their home folder, a drive root, temp. */
function refusalMessage(err: unknown): string {
  const details = (err as { details?: { code?: unknown; reason?: unknown; error?: unknown } })
    .details;
  if (details?.code === 'forbidden_root') {
    const name = forbiddenFolderPlainName(
      typeof details.reason === 'string' ? details.reason : undefined,
    );
    return `Gezel keeps ${name} out of projects, because it holds too much else. Pick a folder inside it instead.`;
  }
  if (details?.code === 'path_not_found') return "That folder doesn't exist any more.";
  if (typeof details?.error === 'string') return details.error;
  return err instanceof Error ? err.message : 'Something went wrong adding that folder.';
}
