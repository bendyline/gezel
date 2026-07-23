import type { GithubWorkingChange } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { GIT_COPY, autoSaveMessage } from './gitCopy.js';

/**
 * The save surface at the bottom of the Changes rail: description box +
 * Save button + "Also send to GitHub now". The description is AI
 * PRE-FILLED — when the change set settles and the user hasn't typed,
 * we fetch a one-line suggestion and drop it in (editable). The user's
 * own text is never overwritten, and saving never blocks on AI: an
 * empty box falls back to a "Updated X and 2 more files" template.
 */

const ALSO_SYNC_KEY = 'gezel:git-also-sync';

interface Props {
  projectId: string;
  changes: GithubWorkingChange[];
  busy: boolean;
  onSave: (message: string, alsoSync: boolean) => void | Promise<void>;
}

export function SaveChangesBox({ projectId, changes, busy, onSave }: Props) {
  const [message, setMessage] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [alsoSync, setAlsoSync] = useState(() => {
    try {
      return window.localStorage.getItem(ALSO_SYNC_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  // Once the user types, the box is theirs — AI never overwrites it.
  const userEditedRef = useRef(false);
  const suggestSeqRef = useRef(0);

  // A stable fingerprint of the change set; suggestions refresh only
  // when this actually changes (not on every 15s poll of equal data).
  const changesKey = useMemo(
    () => changes.map((c) => `${c.path}:${c.additions ?? ''}/${c.deletions ?? ''}`).join(';'),
    [changes],
  );

  const fetchSuggestion = useCallback(
    async (force: boolean) => {
      if (changes.length === 0) return;
      if (!force && userEditedRef.current) return;
      const seq = ++suggestSeqRef.current;
      setSuggesting(true);
      try {
        const res = await api.suggestProjectGithubMessage(projectId);
        if (seq !== suggestSeqRef.current) return; // stale response
        if (!force && userEditedRef.current) return; // user typed meanwhile
        if (res.message) {
          setMessage(res.message);
          userEditedRef.current = false;
        }
      } catch {
        // AI unavailable — the template fallback covers saving.
      } finally {
        if (seq === suggestSeqRef.current) setSuggesting(false);
      }
    },
    [projectId, changes.length],
  );

  // Pre-fill on change-set changes, debounced so a burst of file events
  // (or a save clearing the list) doesn't fire a wasted request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: changesKey is the trigger — a new suggestion only makes sense when the change-set fingerprint moves, not on every render with equal data.
  useEffect(() => {
    if (changes.length === 0) {
      setMessage((prev) => (userEditedRef.current ? prev : ''));
      return;
    }
    const id = window.setTimeout(() => void fetchSuggestion(false), 800);
    return () => window.clearTimeout(id);
  }, [changesKey, changes.length, fetchSuggestion]);

  const submit = useCallback(async () => {
    const text = message.trim() || autoSaveMessage(changes);
    await onSave(text, alsoSync);
    setMessage('');
    userEditedRef.current = false;
  }, [message, changes, alsoSync, onSave]);

  const toggleAlsoSync = useCallback((next: boolean) => {
    setAlsoSync(next);
    try {
      window.localStorage.setItem(ALSO_SYNC_KEY, String(next));
    } catch {
      /* private mode etc. — preference just doesn't stick */
    }
  }, []);

  return (
    <div className="gh-save-box">
      <div className="gh-save-textarea-wrap">
        <textarea
          className={`gh-save-message${suggesting ? ' is-suggesting' : ''}`}
          value={message}
          placeholder={suggesting ? 'Writing a description…' : GIT_COPY.savePlaceholder}
          rows={2}
          onChange={(e) => {
            setMessage(e.target.value);
            userEditedRef.current = e.target.value.trim().length > 0;
          }}
          disabled={busy}
          aria-label="Describe what you changed"
        />
        <button
          type="button"
          className="gh-save-suggest"
          title="Let AI write the description"
          aria-label="Let AI write the description"
          onClick={() => void fetchSuggestion(true)}
          disabled={busy || suggesting || changes.length === 0}
        >
          ✨
        </button>
      </div>
      <label className="gh-save-also-sync small">
        <input
          type="checkbox"
          checked={alsoSync}
          onChange={(e) => toggleAlsoSync(e.target.checked)}
          disabled={busy}
        />
        {GIT_COPY.saveAlsoSync}
      </label>
      <button
        type="button"
        className="gh-save-button primary"
        onClick={() => void submit()}
        disabled={busy || changes.length === 0}
      >
        {busy ? 'Saving…' : alsoSync ? GIT_COPY.saveAndSyncButton : GIT_COPY.saveButton}
      </button>
    </div>
  );
}
