import type { ListPeopleResponse, PersonSummary } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { BlobThumb } from './FindSimilarImages.js';

/**
 * People (face lane): the per-project list of person clusters — exemplar
 * photo, name (anonymous "Person N" until the user answers "Who is this?"),
 * photo count, and Forget. Renders nothing when face recognition is off or
 * no people have surfaced yet — the Settings card owns the opt-in story.
 */
export function PeoplePanel({ projectId }: { projectId: string }) {
  const [people, setPeople] = useState<ListPeopleResponse | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [forgetting, setForgetting] = useState<PersonSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPeople(await api.listPeople(projectId));
    } catch {
      setPeople(null);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fetchBlob = useCallback(
    (path: string) => api.fetchProjectWorkspaceBlob(projectId, path),
    [projectId],
  );

  const commitRename = useCallback(
    async (person: PersonSummary) => {
      const label = draft.trim();
      setRenaming(null);
      if (!label || label === person.label) return;
      setError(null);
      try {
        await api.renamePerson(projectId, person.entityId, label);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [draft, projectId, refresh],
  );

  const forget = useCallback(async () => {
    if (!forgetting) return;
    setError(null);
    try {
      await api.forgetPerson(projectId, forgetting.entityId);
      setForgetting(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [forgetting, projectId, refresh]);

  if (!people?.available || people.people.length === 0) return null;

  return (
    <section className="people-panel">
      <h3>People</h3>
      <p className="muted small">
        Recognized locally from photos in this project. Name someone once and search can find them
        everywhere.
      </p>
      <div className="people-grid">
        {people.people.map((person) => (
          <div key={person.entityId} className="people-card">
            <div className="people-card-photo">
              {person.exemplar ? (
                <BlobThumb path={person.exemplar.path} fetchBlob={fetchBlob} alt={person.label} />
              ) : (
                <span className="similar-thumb-fallback">{person.label.slice(0, 1)}</span>
              )}
            </div>
            {renaming === person.entityId ? (
              <input
                className="people-card-rename"
                value={draft}
                ref={(el) => el?.focus()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitRename(person)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(person);
                  if (e.key === 'Escape') setRenaming(null);
                }}
                aria-label={`Name for ${person.label}`}
              />
            ) : (
              <button
                type="button"
                className="people-card-name"
                title="Who is this?"
                onClick={() => {
                  setDraft(/^Person \d+$/.test(person.label) ? '' : person.label);
                  setRenaming(person.entityId);
                }}
              >
                {person.label}
              </button>
            )}
            <span className="muted small">
              {person.count} photo{person.count === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="people-card-forget"
              onClick={() => setForgetting(person)}
            >
              Forget
            </button>
          </div>
        ))}
      </div>
      {error && <p className="error small">{error}</p>}
      <ConfirmDialog
        open={forgetting !== null}
        title={`Forget ${forgetting?.label ?? 'this person'}?`}
        message="They disappear from People and search, and new photos of them stay unlisted. This does not delete any photos. To erase all face data instead, use Settings."
        confirmLabel="Forget"
        danger
        onConfirm={forget}
        onCancel={() => setForgetting(null)}
      />
    </section>
  );
}
